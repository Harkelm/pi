import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const MODEL: Model<"openai-completions"> = {
	id: "telemetry-model",
	name: "Telemetry Model",
	api: "openai-completions",
	provider: "telemetry-provider",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function createDoneMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "private response" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 5,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("session telemetry", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-telemetry-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("records the real run, step, turn, request, provider, and session-write hierarchy", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(MODEL.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const registry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		registry.registerProvider(MODEL.provider, {
			api: MODEL.api,
			streamSimple: (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					void options?.telemetryContext?.startSpan({ name: "provider.transport" }, () => {
						stream.end(createDoneMessage());
					});
				});
				return stream;
			},
		});
		const telemetryContext = new InMemoryTelemetryContext();
		const sessionManager = SessionManager.inMemory(cwd, { id: "session-test" });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL,
			modelRuntime: getModelRuntime(registry),
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			telemetryContext,
		});

		try {
			await session.prompt("private prompt");
			const spans = telemetryContext.getSpans();
			const run = spans.find((span) => span.name === "pi.harness.run");
			const step = spans.find((span) => span.name === "pi.harness.step");
			const turn = spans.find((span) => span.name === "pi.harness.turn");
			const request = spans.find((span) => span.name === "pi.ai.request");
			const provider = spans.find((span) => span.name === "provider.transport");
			const writes = spans.filter((span) => span.name === "pi.session.write");
			expect(run?.attributes).toMatchObject({
				"pi.session.id": "session-test",
				"pi.operation.kind": "run",
				"pi.operation.outcome": "completed",
			});
			expect(step?.parentId).toBe(run?.id);
			expect(step?.attributes).toMatchObject({
				"pi.step.kind": "assistant",
				"pi.step.attempt": 1,
				"pi.step.outcome": "succeeded",
			});
			expect(turn?.parentId).toBe(step?.id);
			expect(request?.parentId).toBe(turn?.id);
			expect(provider?.parentId).toBe(request?.id);
			expect(writes.length).toBeGreaterThanOrEqual(2);
			expect(writes.every((write) => write.parentId === step?.id)).toBe(true);
			expect(JSON.stringify(spans)).not.toContain("private prompt");
			expect(JSON.stringify(spans)).not.toContain("private response");
		} finally {
			session.dispose();
			registry.unregisterProvider(MODEL.provider);
		}
	});
});
