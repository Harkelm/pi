import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const MODEL: Model<"openai-responses"> = {
	id: "gpt-4o-mini",
	name: "gpt-4o-mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function responseMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "private response" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		responseId: "response-test",
		usage: {
			input: 12,
			output: 4,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 21,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("agent telemetry", () => {
	it("records real AI request semantics and gives provider spans the AI parent", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const agent = new Agent({
			telemetryContext,
			initialState: { model: MODEL },
			streamFn: (_model, _context, options) => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					void options?.telemetryContext?.startSpan({ name: "provider.transport" }, () => {
						response.push({ type: "done", reason: "stop", message: responseMessage() });
					});
				});
				return response;
			},
		});

		await agent.prompt("private prompt");

		const spans = telemetryContext.getSpans();
		const request = spans.find((span) => span.name === "pi.ai.request");
		const provider = spans.find((span) => span.name === "provider.transport");
		expect(request?.settled).toBe(true);
		expect(provider?.parentId).toBe(request?.id);
		expect(request?.attributes).toMatchObject({
			"pi.ai.operation": "stream",
			"pi.ai.provider": "openai",
			"pi.ai.model": "gpt-4o-mini",
			"pi.ai.response.id": "response-test",
			"pi.ai.response.stop_reason": "stop",
			"pi.ai.usage.input_tokens": 12,
			"pi.ai.usage.output_tokens": 4,
			"pi.ai.usage.total_tokens": 21,
			"pi.ai.stream.chunk_count": 1,
		});
		expect(JSON.stringify(spans)).not.toContain("private prompt");
		expect(JSON.stringify(spans)).not.toContain("private response");
	});
});
