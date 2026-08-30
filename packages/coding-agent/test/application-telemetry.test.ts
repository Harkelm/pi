import { afterEach, describe, expect, it } from "vitest";
import { createApplicationTelemetry, shutdownApplicationTelemetry } from "../src/core/application-telemetry.ts";

const originalDisabled = process.env.PI_OTEL_DISABLED;
const originalEndpoint = process.env.PI_OTEL_EXPORTER_OTLP_ENDPOINT;

afterEach(() => {
	if (originalDisabled === undefined) delete process.env.PI_OTEL_DISABLED;
	else process.env.PI_OTEL_DISABLED = originalDisabled;
	if (originalEndpoint === undefined) delete process.env.PI_OTEL_EXPORTER_OTLP_ENDPOINT;
	else process.env.PI_OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
});

describe("application telemetry", () => {
	it("honors the explicit disable flag even when an endpoint is inherited", async () => {
		process.env.PI_OTEL_DISABLED = "1";
		process.env.PI_OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
		const runtime = createApplicationTelemetry("test");
		try {
			expect(runtime).toBeUndefined();
		} finally {
			await shutdownApplicationTelemetry(runtime);
		}
	});
});
