import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const telemetryContext = new InMemoryTelemetryContext();
		const result = retryProviderRequest(request, { maxRetries: 1, telemetryContext });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
		const spans = telemetryContext.getSpans();
		expect(spans.filter((span) => span.name === "pi.ai.provider_attempt").map((span) => span.attributes)).toEqual([
			expect.objectContaining({
				"pi.ai.provider_attempt": 1,
				"pi.ai.provider_retry": false,
				"pi.ai.provider_outcome": "failed",
				"pi.ai.http.status_code": 429,
			}),
			expect.objectContaining({
				"pi.ai.provider_attempt": 2,
				"pi.ai.provider_retry": true,
				"pi.ai.provider_outcome": "completed",
			}),
		]);
		expect(spans.find((span) => span.name === "pi.ai.retry_sleep")?.attributes).toMatchObject({
			"pi.ai.retry.delay_ms": 1000,
			"pi.ai.retry.next_attempt": 2,
			"pi.ai.retry.outcome": "elapsed",
		});
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const telemetryContext = new InMemoryTelemetryContext();
		const result = retryProviderRequest(request, {
			maxRetries: 2,
			maxRetryDelayMs: 0,
			signal: controller.signal,
			telemetryContext,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		const sleepSpan = telemetryContext.getSpans().find((span) => span.name === "pi.ai.retry_sleep");
		expect(sleepSpan?.attributes).toMatchObject({ "pi.ai.retry.outcome": "aborted" });
		expect(sleepSpan?.status.status).toBe("error");
	});
});
