import { randomUUID } from "node:crypto";
import process from "node:process";
import type {
	AttributeValue,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { type Context, context as otelContext, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BatchSpanProcessor,
	SimpleSpanProcessor,
	type SpanExporter,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	ATTR_SERVICE_INSTANCE_ID,
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_NAMESPACE,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const DEFAULT_MAX_QUEUE_SIZE = 2_048;
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 256;
const DEFAULT_SCHEDULED_DELAY_MS = 1_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 1_000;

export interface OpenTelemetryRuntimeOptions {
	/** Full OTLP HTTP/protobuf traces endpoint, including `/v1/traces`. */
	endpoint: string;
	serviceName: string;
	serviceVersion?: string;
	serviceNamespace?: string;
	serviceInstanceId?: string;
	/** Test and embedding seam. Production callers normally use the OTLP exporter. */
	exporter?: SpanExporter;
	/** Use synchronous export. Intended for deterministic tests only. */
	simpleProcessor?: boolean;
}

export interface OpenTelemetryRuntime {
	readonly telemetryContext: TelemetryContext;
	contextForSession(sessionId: string): TelemetryContext;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
}

type OTelAttributeValue = string | number | boolean | string[] | number[] | boolean[];

function copyAttributeValue(value: AttributeValue): OTelAttributeValue {
	if (Array.isArray(value)) return [...value] as string[] | number[] | boolean[];
	return value as string | number | boolean;
}

function copyAttributes(attributes: SpanAttributes | undefined): Record<string, OTelAttributeValue> {
	const copied: Record<string, OTelAttributeValue> = {};
	if (!attributes) return copied;
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) copied[key] = copyAttributeValue(value);
	}
	return copied;
}

function finishReason(value: OTelAttributeValue | undefined): string[] | undefined {
	if (typeof value !== "string") return undefined;
	return [value];
}

/** Add stable GenAI and OpenInference projections without removing Pi's typed fields. */
function projectAttributes(spanName: string, source: SpanAttributes | undefined): Record<string, OTelAttributeValue> {
	const attributes = copyAttributes(source);
	const sessionId = attributes["pi.session.id"];
	if (typeof sessionId === "string") attributes["session.id"] = sessionId;

	if (spanName === "pi.ai.request") {
		attributes["openinference.span.kind"] = "LLM";
		const operation = attributes["pi.ai.operation"];
		if (typeof operation === "string") {
			attributes["gen_ai.operation.name"] = operation === "stream" ? "chat" : operation;
		}
		const provider = attributes["pi.ai.provider"];
		if (typeof provider === "string") attributes["gen_ai.provider.name"] = provider;
		const requestModel = attributes["pi.ai.model"];
		if (typeof requestModel === "string") {
			attributes["gen_ai.request.model"] = requestModel;
			attributes["llm.model_name"] = requestModel;
		}
		const responseModel = attributes["pi.ai.response.model"];
		if (typeof responseModel === "string") attributes["gen_ai.response.model"] = responseModel;
		const responseId = attributes["pi.ai.response.id"];
		if (typeof responseId === "string") attributes["gen_ai.response.id"] = responseId;
		const reasons = finishReason(attributes["pi.ai.response.stop_reason"]);
		if (reasons) attributes["gen_ai.response.finish_reasons"] = reasons;

		const input = attributes["pi.ai.usage.input_tokens"];
		if (typeof input === "number") {
			attributes["gen_ai.usage.input_tokens"] = input;
			attributes["llm.token_count.prompt"] = input;
		}
		const output = attributes["pi.ai.usage.output_tokens"];
		if (typeof output === "number") {
			attributes["gen_ai.usage.output_tokens"] = output;
			attributes["llm.token_count.completion"] = output;
		}
		const total = attributes["pi.ai.usage.total_tokens"];
		if (typeof total === "number") attributes["llm.token_count.total"] = total;
		const cacheRead = attributes["pi.ai.usage.cache_read_tokens"];
		if (typeof cacheRead === "number") attributes["llm.token_count.prompt_details.cache_read"] = cacheRead;
		const cacheWrite = attributes["pi.ai.usage.cache_write_tokens"];
		if (typeof cacheWrite === "number") {
			attributes["llm.token_count.prompt_details.cache_write"] = cacheWrite;
		}
		const cost = attributes["pi.ai.usage.cost"];
		if (typeof cost === "number") attributes["llm.cost.total"] = cost;
	} else if (spanName === "pi.harness.run") {
		attributes["openinference.span.kind"] = "AGENT";
	} else if (spanName === "pi.harness.tool") {
		attributes["openinference.span.kind"] = "TOOL";
		const toolName = attributes["pi.tool.name"];
		if (typeof toolName === "string") attributes["tool.name"] = toolName;
		const callId = attributes["pi.tool.call_id"];
		if (typeof callId === "string") attributes["gen_ai.tool.call.id"] = callId;
	}

	return attributes;
}

class OpenTelemetryContext implements TelemetryContext {
	private readonly tracer: Tracer;
	private readonly parentContext: Context;
	private readonly inheritedAttributes: Readonly<Record<string, OTelAttributeValue>>;

	constructor(
		tracer: Tracer,
		parentContext: Context,
		inheritedAttributes: Readonly<Record<string, OTelAttributeValue>>,
	) {
		this.tracer = tracer;
		this.parentContext = parentContext;
		this.inheritedAttributes = inheritedAttributes;
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		const attributes = {
			...this.inheritedAttributes,
			...projectAttributes(options.name, options.attributes),
		};
		const otelSpan = this.tracer.startSpan(options.name, { attributes }, this.parentContext);
		const childContext = trace.setSpan(this.parentContext, otelSpan);
		const span = new OpenTelemetrySpan(this.tracer, childContext, this.inheritedAttributes, options.name, otelSpan);

		let result: T | Promise<T>;
		try {
			result = otelContext.with(childContext, callback, undefined, span);
		} catch (error) {
			otelSpan.setStatus({ code: SpanStatusCode.ERROR });
			otelSpan.end();
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => {
				otelSpan.end();
				return value;
			},
			(error: unknown) => {
				otelSpan.setStatus({ code: SpanStatusCode.ERROR });
				otelSpan.end();
				throw error;
			},
		);
	}
}

class OpenTelemetrySpan extends OpenTelemetryContext implements TelemetrySpan {
	private readonly spanName: string;
	private readonly span: ReturnType<Tracer["startSpan"]>;

	constructor(
		tracer: Tracer,
		parentContext: Context,
		inheritedAttributes: Readonly<Record<string, OTelAttributeValue>>,
		spanName: string,
		span: ReturnType<Tracer["startSpan"]>,
	) {
		super(tracer, parentContext, inheritedAttributes);
		this.spanName = spanName;
		this.span = span;
	}

	addEvent(name: string, attributes?: SpanAttributes): void {
		this.span.addEvent(name, copyAttributes(attributes));
	}

	setAttributes(attributes: SpanAttributes): void {
		this.span.setAttributes(projectAttributes(this.spanName, attributes));
	}

	setStatus(status: SpanStatus): void {
		this.span.setStatus({ code: status.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
	}
}

function processCreationTime(): string {
	return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}

function validateOptions(options: OpenTelemetryRuntimeOptions): URL {
	if (!options.serviceName.trim()) throw new Error("serviceName must not be empty");
	const endpoint = new URL(options.endpoint);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("endpoint must use HTTP or HTTPS");
	}
	return endpoint;
}

export function createOpenTelemetryRuntime(options: OpenTelemetryRuntimeOptions): OpenTelemetryRuntime {
	const endpoint = validateOptions(options);
	const exporter = options.exporter ?? new OTLPTraceExporter({ url: endpoint.href });
	const processor: SpanProcessor = options.simpleProcessor
		? new SimpleSpanProcessor(exporter)
		: new BatchSpanProcessor(exporter, {
				maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
				maxExportBatchSize: DEFAULT_MAX_EXPORT_BATCH_SIZE,
				scheduledDelayMillis: DEFAULT_SCHEDULED_DELAY_MS,
				exportTimeoutMillis: DEFAULT_EXPORT_TIMEOUT_MS,
			});
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAMESPACE]: options.serviceNamespace ?? "fleet",
		[ATTR_SERVICE_NAME]: options.serviceName,
		...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
		[ATTR_SERVICE_INSTANCE_ID]: options.serviceInstanceId ?? randomUUID(),
		"process.pid": process.pid,
		"process.creation.time": processCreationTime(),
		"process.command": options.serviceName,
		"fleet.telemetry.capture": "live",
		"fleet.telemetry.fidelity": "exact",
		"fleet.telemetry.source": options.serviceName,
	});
	const provider = new NodeTracerProvider({ resource, spanProcessors: [processor] });
	provider.register();
	const tracer = provider.getTracer("@earendil-works/pi-telemetry-otel", options.serviceVersion);
	const rootContext = new OpenTelemetryContext(tracer, otelContext.active(), {});
	let shutdownPromise: Promise<void> | undefined;

	return {
		telemetryContext: rootContext,
		contextForSession(sessionId: string): TelemetryContext {
			if (!sessionId) throw new Error("sessionId must not be empty");
			return new OpenTelemetryContext(tracer, otelContext.active(), { "session.id": sessionId });
		},
		async forceFlush(): Promise<void> {
			if (!shutdownPromise) await provider.forceFlush();
		},
		shutdown(): Promise<void> {
			shutdownPromise ??= provider.shutdown();
			return shutdownPromise;
		},
	};
}
