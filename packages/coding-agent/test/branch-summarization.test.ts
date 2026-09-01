import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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
	it("uses the authority-safe default prompt without overriding tool choice", async () => {
		let requestContext: Context | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, context, options) => {
			requestContext = context;
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
		const prompt = JSON.stringify(requestContext?.messages);
		expect(prompt).toContain("## Reported User Authority");
		expect(prompt).toContain("## Remaining Authorized Work");
		expect(prompt).toContain("## Suggestions (Not Authorized)");
		expect(prompt).not.toContain("## Next Steps");
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
