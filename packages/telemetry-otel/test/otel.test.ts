import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createOpenTelemetryRuntime } from "../src/index.ts";

describe("OpenTelemetry adapter", () => {
	it("exports Pi fields with session, GenAI, and OpenInference projections", async () => {
		const exporter = new InMemorySpanExporter();
		const runtime = createOpenTelemetryRuntime({
			endpoint: "http://127.0.0.1:4318/v1/traces",
			serviceName: "pi",
			serviceVersion: "test",
			serviceInstanceId: "instance-test",
			exporter,
			simpleProcessor: true,
		});

		await runtime.contextForSession("session-test").startSpan(
			{
				name: "pi.ai.request",
				attributes: {
					"pi.ai.operation": "stream",
					"pi.ai.provider": "provider-test",
					"pi.ai.model": "model-test",
					"pi.ai.api": "api-test",
					"pi.ai.streaming": true,
				},
			},
			(span) => {
				span.setAttributes({
					"pi.ai.response.model": "response-model-test",
					"pi.ai.response.id": "response-test",
					"pi.ai.response.stop_reason": "stop",
					"pi.ai.usage.input_tokens": 10,
					"pi.ai.usage.output_tokens": 4,
					"pi.ai.usage.cache_read_tokens": 3,
					"pi.ai.usage.cache_write_tokens": 2,
					"pi.ai.usage.total_tokens": 19,
					"pi.ai.usage.cost": 0.25,
				});
			},
		);
		await runtime.forceFlush();

		const [span] = exporter.getFinishedSpans();
		expect(span?.name).toBe("pi.ai.request");
		expect(span?.attributes).toMatchObject({
			"session.id": "session-test",
			"pi.ai.provider": "provider-test",
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "provider-test",
			"gen_ai.request.model": "model-test",
			"gen_ai.response.model": "response-model-test",
			"openinference.span.kind": "LLM",
			"llm.model_name": "model-test",
			"llm.token_count.prompt": 10,
			"llm.token_count.completion": 4,
			"llm.token_count.total": 19,
			"llm.cost.total": 0.25,
		});
		expect(span?.resource.attributes).toMatchObject({
			"service.namespace": "fleet",
			"service.name": "pi",
			"service.version": "test",
			"service.instance.id": "instance-test",
			"fleet.telemetry.capture": "live",
			"fleet.telemetry.fidelity": "exact",
			"fleet.telemetry.source": "pi",
		});
		expect(Object.keys(span?.attributes ?? {})).not.toContain("prompt");
		expect(Object.keys(span?.attributes ?? {})).not.toContain("response.content");

		await runtime.shutdown();
	});
});
