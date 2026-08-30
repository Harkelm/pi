import { createOpenTelemetryRuntime, type OpenTelemetryRuntime } from "@earendil-works/pi-telemetry-otel";

const PI_OTEL_DISABLED_ENV = "PI_OTEL_DISABLED";
const PI_OTLP_ENDPOINT_ENV = "PI_OTEL_EXPORTER_OTLP_ENDPOINT";

/** Initialize optional trace export without making telemetry a startup dependency. */
export function createApplicationTelemetry(serviceVersion: string): OpenTelemetryRuntime | undefined {
	if (process.env[PI_OTEL_DISABLED_ENV] === "1") return undefined;
	const endpoint = process.env[PI_OTLP_ENDPOINT_ENV]?.trim();
	if (!endpoint) return undefined;
	try {
		return createOpenTelemetryRuntime({
			endpoint,
			serviceName: "pi",
			serviceVersion,
			serviceNamespace: "fleet",
		});
	} catch {
		return undefined;
	}
}

/** Flush and stop telemetry without changing the application's outcome. */
export async function shutdownApplicationTelemetry(runtime: OpenTelemetryRuntime | undefined): Promise<void> {
	if (!runtime) return;
	try {
		await runtime.shutdown();
	} catch {
		// Telemetry is observational. Export failures cannot fail the application.
	}
}
