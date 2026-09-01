import { createOpenTelemetryRuntime, type OpenTelemetryRuntime } from "@earendil-works/pi-telemetry-otel";

const PI_OTEL_DISABLED_ENV = "PI_OTEL_DISABLED";
const PI_OTLP_ENDPOINT_ENV = "PI_OTEL_EXPORTER_OTLP_ENDPOINT";
export const PI_OTEL_PARENT_TRACEPARENT_ENV = "PI_OTEL_PARENT_TRACEPARENT";
export const PI_OTEL_PARENT_TRACESTATE_ENV = "PI_OTEL_PARENT_TRACESTATE";
export const PI_OTEL_PARENT_SESSION_ID_ENV = "PI_OTEL_PARENT_SESSION_ID";
export const PI_OTEL_PARENT_PROCESS_PID_ENV = "PI_OTEL_PARENT_PROCESS_PID";
export const PI_OTEL_SUBAGENT_ID_ENV = "PI_OTEL_SUBAGENT_ID";

/** Initialize optional trace export without making telemetry a startup dependency. */
export function createApplicationTelemetry(serviceVersion: string): OpenTelemetryRuntime | undefined {
	if (process.env[PI_OTEL_DISABLED_ENV] === "1") return undefined;
	const endpoint = process.env[PI_OTLP_ENDPOINT_ENV]?.trim();
	if (!endpoint) return undefined;
	try {
		const traceparent = process.env[PI_OTEL_PARENT_TRACEPARENT_ENV]?.trim();
		const tracestate = process.env[PI_OTEL_PARENT_TRACESTATE_ENV]?.trim();
		const parentSessionId = process.env[PI_OTEL_PARENT_SESSION_ID_ENV]?.trim();
		const parentProcessPid = Number.parseInt(process.env[PI_OTEL_PARENT_PROCESS_PID_ENV] ?? "", 10);
		const subagentId = process.env[PI_OTEL_SUBAGENT_ID_ENV]?.trim();
		return createOpenTelemetryRuntime({
			endpoint,
			serviceName: "pi",
			serviceVersion,
			serviceNamespace: "fleet",
			...(traceparent ? { parentTraceContext: { traceparent, ...(tracestate ? { tracestate } : {}) } } : {}),
			inheritedAttributes: {
				...(subagentId ? { "pi.process.role": "managed_subagent", "pi.subagent.id": subagentId } : {}),
				...(parentSessionId ? { "pi.parent.session.id": parentSessionId } : {}),
				...(Number.isSafeInteger(parentProcessPid) && parentProcessPid > 0
					? { "pi.parent.process.pid": parentProcessPid }
					: {}),
			},
		});
	} catch {
		return undefined;
	}
}

/** Flush and stop telemetry without changing the application's outcome. */
export async function shutdownApplicationTelemetry(runtime: OpenTelemetryRuntime | undefined): Promise<void> {
	if (!runtime) return;
	try {
		await runtime.telemetryContext.startSpan(
			{ name: "pi.process.shutdown", attributes: { "pi.process.shutdown.reason": "cli_exit" } },
			() => {},
		);
	} catch {
		// Telemetry is observational. Recording failures cannot fail the application.
	}
	try {
		await runtime.shutdown();
	} catch {
		// Collector failures cannot fail the application.
	}
}
