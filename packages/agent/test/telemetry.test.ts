import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentTool } from "../src/types.ts";

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

	it("records an observed aborted request without error content", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const agent = new Agent({
			telemetryContext,
			initialState: { model: MODEL },
			streamFn: () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push({
						type: "error",
						reason: "aborted",
						error: {
							...responseMessage(),
							stopReason: "aborted",
							errorMessage: "private cancellation detail",
						},
					});
				});
				return response;
			},
		});

		await agent.prompt("private prompt");

		const request = telemetryContext.getSpans().find((span) => span.name === "pi.ai.request");
		expect(request?.attributes).toMatchObject({
			"pi.ai.response.stop_reason": "aborted",
			"pi.ai.error.type": "aborted",
		});
		expect(request?.status.status).toBe("error");
		expect(JSON.stringify(request)).not.toContain("private");
	});

	it("records turn and tool hierarchy with success, failure, and content-free attributes", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const Parameters = Type.Object({});
		const tools: AgentTool<typeof Parameters>[] = [
			{
				name: "successful_tool",
				label: "Successful tool",
				description: "Returns a private result",
				parameters: Parameters,
				execute: async () => ({
					content: [{ type: "text", text: "private tool result" }],
					details: {},
				}),
			},
			{
				name: "failing_tool",
				label: "Failing tool",
				description: "Throws a private error",
				parameters: Parameters,
				execute: async () => {
					throw new Error("private tool failure");
				},
			},
		];
		let request = 0;

		await telemetryContext.startSpan({ name: "pi.harness.run" }, async (run) => {
			await run.startSpan({ name: "pi.harness.step" }, async (step) => {
				const agent = new Agent({
					telemetryContext: step,
					telemetryOperation: { laneName: "main", operationId: "operation-test", stepAttempt: 1 },
					initialState: { model: MODEL, tools },
					streamFn: () => {
						const response = new MockAssistantStream();
						queueMicrotask(() => {
							if (request++ === 0) {
								response.push({
									type: "done",
									reason: "toolUse",
									message: {
										...responseMessage(),
										content: [
											{ type: "toolCall", id: "success-1", name: "successful_tool", arguments: {} },
											{ type: "toolCall", id: "failure-1", name: "failing_tool", arguments: {} },
										],
										stopReason: "toolUse",
									},
								});
							} else {
								response.push({ type: "done", reason: "stop", message: responseMessage() });
							}
						});
						return response;
					},
				});
				await agent.prompt("private prompt");
			});
		});

		const spans = telemetryContext.getSpans();
		const run = spans.find((span) => span.name === "pi.harness.run");
		const step = spans.find((span) => span.name === "pi.harness.step");
		const turns = spans.filter((span) => span.name === "pi.harness.turn");
		const requests = spans.filter((span) => span.name === "pi.ai.request");
		const toolSpans = spans.filter((span) => span.name === "pi.harness.tool");
		expect(step?.parentId).toBe(run?.id);
		expect(turns).toHaveLength(2);
		expect(turns.every((turn) => turn.parentId === step?.id)).toBe(true);
		expect(requests.map((span) => span.parentId)).toEqual(turns.map((turn) => turn.id));
		expect(toolSpans).toHaveLength(2);
		expect(toolSpans.every((span) => span.parentId === turns[0]?.id)).toBe(true);
		expect(toolSpans.map((span) => span.attributes)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					"pi.tool.name": "successful_tool",
					"pi.tool.call_id": "success-1",
					"pi.tool.is_error": false,
					"pi.tool.outcome": "completed",
					"pi.tool.result_size_bytes": 19,
				}),
				expect.objectContaining({
					"pi.tool.name": "failing_tool",
					"pi.tool.call_id": "failure-1",
					"pi.tool.is_error": true,
					"pi.tool.outcome": "error",
				}),
			]),
		);
		const serialized = JSON.stringify(spans);
		expect(serialized).not.toContain("private prompt");
		expect(serialized).not.toContain("private response");
		expect(serialized).not.toContain("private tool result");
		expect(serialized).not.toContain("private tool failure");
	});
});
