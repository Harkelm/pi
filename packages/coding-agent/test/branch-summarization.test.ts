import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("branch summarization", () => {
	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("records branch-summary requests under their structural step", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const streamFn: StreamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				void options?.telemetryContext?.startSpan({ name: "provider.transport" }, () => {
					stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) });
				});
			});
			return stream;
		};

		await telemetryContext.startSpan({ name: "pi.harness.navigation" }, async (navigation) => {
			await navigation.startSpan({ name: "pi.harness.step" }, async (step) => {
				await generateBranchSummary(entries, {
					model,
					signal: new AbortController().signal,
					streamFn,
					telemetryContext: step,
				});
			});
		});

		const spans = telemetryContext.getSpans();
		const navigation = spans.find((span) => span.name === "pi.harness.navigation");
		const step = spans.find((span) => span.name === "pi.harness.step");
		const request = spans.find((span) => span.name === "pi.ai.request");
		const provider = spans.find((span) => span.name === "provider.transport");
		expect(step?.parentId).toBe(navigation?.id);
		expect(request?.parentId).toBe(step?.id);
		expect(request?.attributes["pi.ai.purpose"]).toBe("branch_summary");
		expect(provider?.parentId).toBe(request?.id);
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});
});
