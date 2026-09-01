import { InMemoryTelemetryContext, type TelemetryContext } from "@earendil-works/pi-telemetry";
import type { OpenTelemetryRuntime } from "@earendil-works/pi-telemetry-otel";
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

	it("keeps recording and Collector shutdown failures non-blocking", async () => {
		let shutdownCalled = false;
		const telemetryContext: TelemetryContext = {
			startSpan: <Result>(): Promise<Result> => Promise.reject(new Error("recording unavailable")),
		};
		const runtime = {
			telemetryContext,
			contextForSession: () => telemetryContext,
			forceFlush: async () => {},
			shutdown: async () => {
				shutdownCalled = true;
				throw new Error("Collector unavailable");
			},
		} satisfies OpenTelemetryRuntime;

		await expect(shutdownApplicationTelemetry(runtime)).resolves.toBeUndefined();
		expect(shutdownCalled).toBe(true);
	});

	it("records shutdown before closing the exporter", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		let shutdownCalled = false;
		const runtime = {
			telemetryContext,
			contextForSession: () => telemetryContext,
			forceFlush: async () => {},
			shutdown: async () => {
				shutdownCalled = true;
			},
		} satisfies OpenTelemetryRuntime;

		await shutdownApplicationTelemetry(runtime);

		expect(shutdownCalled).toBe(true);
		expect(telemetryContext.getSpans()).toEqual([
			expect.objectContaining({
				name: "pi.process.shutdown",
				attributes: { "pi.process.shutdown.reason": "cli_exit" },
				settled: true,
			}),
		]);
	});
});
