/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { type HarnessTelemetrySpan, startAiSpan, startHarnessSpan } from "./harness/telemetry.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let turnIndex = 0;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const completedTurn = await executeTurn(
				currentContext,
				newMessages,
				config,
				signal,
				emit,
				streamFunction,
				turnIndex++,
			);
			if (completedTurn.terminal) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			hasMoreToolCalls = completedTurn.hasMoreToolCalls;
			lastCompletedTurn = completedTurn.context;

			if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

type CompletedTurn =
	| { terminal: true }
	| { terminal: false; hasMoreToolCalls: boolean; context: PrepareNextTurnContext };

async function executeTurn(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	turnIndex: number,
): Promise<CompletedTurn> {
	const operation = config.telemetryOperation;
	const turnId = operation ? `${operation.operationId}:${operation.stepAttempt}:${turnIndex}` : undefined;
	const execute = async (turnTelemetryContext = config.telemetryContext): Promise<CompletedTurn> => {
		const turnConfig = { ...config, telemetryContext: turnTelemetryContext, telemetryTurnId: turnId };
		const message = await streamAssistantResponse(currentContext, turnConfig, signal, emit, streamFunction);
		newMessages.push(message);

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			await emit({ type: "turn_end", message, toolResults: [] });
			return { terminal: true };
		}

		const toolCalls = message.content.filter((content) => content.type === "toolCall");
		const toolResults: ToolResultMessage[] = [];
		let hasMoreToolCalls = false;
		if (toolCalls.length > 0) {
			const executedToolBatch =
				message.stopReason === "length"
					? await failToolCallsFromTruncatedMessage(toolCalls, emit, turnConfig)
					: await executeToolCalls(currentContext, message, turnConfig, signal, emit);
			toolResults.push(...executedToolBatch.messages);
			hasMoreToolCalls = !executedToolBatch.terminate;
			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}
		}

		await emit({ type: "turn_end", message, toolResults });
		return {
			terminal: false,
			hasMoreToolCalls,
			context: { message, toolResults, context: currentContext, newMessages },
		};
	};

	if (!config.telemetryContext || !operation || !turnId) return execute();
	return startHarnessSpan(
		config.telemetryContext,
		"pi.harness.turn",
		{
			"pi.lane.name": operation.laneName,
			"pi.operation.id": operation.operationId,
			"pi.turn.id": turnId,
		},
		(span) => execute(span),
	);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	if (!config.telemetryContext) {
		return streamAssistantResponseBody(context, config, signal, emit, streamFunction);
	}

	return startAiSpan(
		config.telemetryContext,
		"pi.ai.request",
		{
			"pi.ai.operation": "stream",
			"pi.ai.provider": config.model.provider,
			"pi.ai.model": config.model.id,
			"pi.ai.api": config.model.api,
			"pi.ai.streaming": true,
			"pi.ai.deferred": config.deferred !== undefined && config.deferred !== false,
			"pi.ai.purpose": "assistant",
		},
		async (span) => {
			const startedAt = performance.now();
			let firstEventMs: number | undefined;
			let firstTextDeltaMs: number | undefined;
			let httpStatus: number | undefined;
			let chunkCount = 0;
			const finalMessage = await streamAssistantResponseBody(
				context,
				config,
				signal,
				emit,
				streamFunction,
				span,
				(eventType) => {
					chunkCount++;
					firstEventMs ??= performance.now() - startedAt;
					if (eventType === "text_delta") firstTextDeltaMs ??= performance.now() - startedAt;
				},
				(status) => {
					httpStatus = status;
				},
			);
			span.setAttributes({
				...(finalMessage.responseId ? { "pi.ai.response.id": finalMessage.responseId } : {}),
				"pi.ai.response.model": finalMessage.responseModel ?? finalMessage.model,
				"pi.ai.response.stop_reason": normalizeTelemetryStopReason(finalMessage.stopReason),
				"pi.ai.usage.input_tokens": finalMessage.usage.input,
				"pi.ai.usage.output_tokens": finalMessage.usage.output,
				"pi.ai.usage.cache_read_tokens": finalMessage.usage.cacheRead,
				"pi.ai.usage.cache_write_tokens": finalMessage.usage.cacheWrite,
				...(finalMessage.usage.cacheWrite1h === undefined
					? {}
					: { "pi.ai.usage.cache_write_1h_tokens": finalMessage.usage.cacheWrite1h }),
				...(finalMessage.usage.reasoning === undefined
					? {}
					: { "pi.ai.usage.reasoning_tokens": finalMessage.usage.reasoning }),
				"pi.ai.usage.total_tokens": finalMessage.usage.totalTokens,
				"pi.ai.usage.cost": finalMessage.usage.cost.total,
				...(httpStatus === undefined ? {} : { "pi.ai.http.status_code": httpStatus }),
				...(firstEventMs === undefined ? {} : { "pi.ai.stream.time_to_first_event_ms": firstEventMs }),
				...(firstTextDeltaMs === undefined
					? {}
					: {
							"pi.ai.stream.time_to_first_text_delta_ms": firstTextDeltaMs,
							"pi.ai.stream.text_timing_fidelity": "stream_delta_not_token" as const,
						}),
				"pi.ai.stream.chunk_count": chunkCount,
				...(finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted"
					? { "pi.ai.error.type": finalMessage.stopReason === "aborted" ? "aborted" : "provider_error" }
					: {}),
			});
			if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
				span.setStatus({ status: "error" });
			}
			return finalMessage;
		},
	);
}

function normalizeTelemetryStopReason(
	stopReason: AssistantMessage["stopReason"],
): "stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" {
	if (stopReason === "toolUse") return "tool_use";
	if (stopReason === "pending") return "error";
	return stopReason;
}

async function streamAssistantResponseBody(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	requestTelemetryContext = config.telemetryContext,
	onChunk?: (eventType: string) => void,
	onHttpResponse?: (status: number) => void,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
		telemetryContext: requestTelemetryContext,
		onResponse: async (providerResponse, model) => {
			onHttpResponse?.(providerResponse.status);
			await config.onResponse?.(providerResponse, model);
		},
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		onChunk?.(event.type);
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
	config: AgentLoopConfig,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await recordImmediateToolCall(finalized, config);
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const scheduled = scheduleToolCall(currentContext, assistantMessage, toolCall, config, signal, emit);
		if ((await scheduled.preparation) === "prepared") scheduled.release();
		const finalized = await scheduled.result;

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const scheduled = scheduleToolCall(currentContext, assistantMessage, toolCall, config, signal, emit);
		if ((await scheduled.preparation) === "immediate") {
			const finalized = await scheduled.result;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) break;
			continue;
		}

		finalizedCalls.push(async () => {
			scheduled.release();
			const finalized = await scheduled.result;
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function imageDataBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function toolResultSizeBytes(result: AgentToolResult<any>): number {
	let bytes = 0;
	for (const content of result.content ?? []) {
		bytes +=
			content.type === "text" ? new TextEncoder().encode(content.text).byteLength : imageDataBytes(content.data);
	}
	return bytes;
}

function toolStartAttributes(toolCall: AgentToolCall, config: AgentLoopConfig) {
	const operation = config.telemetryOperation;
	if (!operation) return undefined;
	return {
		"pi.lane.name": operation.laneName,
		"pi.operation.id": operation.operationId,
		...(config.telemetryTurnId ? { "pi.turn.id": config.telemetryTurnId } : {}),
		"pi.tool.name": toolCall.name,
		"pi.tool.call_id": toolCall.id,
	};
}

async function recordImmediateToolCall(finalized: FinalizedToolCallOutcome, config: AgentLoopConfig): Promise<void> {
	const attributes = toolStartAttributes(finalized.toolCall, config);
	if (!config.telemetryContext || !attributes) return;
	await startHarnessSpan(config.telemetryContext, "pi.harness.tool", attributes, (span) => {
		span.setAttributes({
			"pi.tool.is_error": finalized.isError,
			"pi.tool.result_size_bytes": toolResultSizeBytes(finalized.result),
			"pi.tool.outcome": finalized.isError ? "error" : "completed",
		});
		if (finalized.isError) span.setStatus({ status: "error" });
	});
}

type ScheduledToolCall = {
	preparation: Promise<"immediate" | "prepared">;
	release(): void;
	result: Promise<FinalizedToolCallOutcome>;
};

function scheduleToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): ScheduledToolCall {
	let resolvePreparation = (_kind: "immediate" | "prepared") => {};
	let rejectPreparation = (_error: unknown) => {};
	const preparation = new Promise<"immediate" | "prepared">((resolve, reject) => {
		resolvePreparation = resolve;
		rejectPreparation = reject;
	});
	let release = () => {};
	const executionGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const execute = async (span?: HarnessTelemetrySpan<"pi.harness.tool">) => {
		const preparationStartedAt = performance.now();
		let prepared: PreparedToolCall | ImmediateToolCallOutcome;
		try {
			prepared = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		} catch (error) {
			rejectPreparation(error);
			throw error;
		}
		let activeDurationMs = performance.now() - preparationStartedAt;
		let finalized: FinalizedToolCallOutcome;
		if (prepared.kind === "immediate") {
			resolvePreparation("immediate");
			finalized = { toolCall, result: prepared.result, isError: prepared.isError };
		} else {
			resolvePreparation("prepared");
			await executionGate;
			const executionStartedAt = performance.now();
			const executed = await executePreparedToolCall(prepared, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				prepared,
				executed,
				config,
				signal,
			);
			activeDurationMs += performance.now() - executionStartedAt;
		}
		span?.setAttributes({
			"pi.tool.is_error": finalized.isError,
			"pi.tool.duration_ms": activeDurationMs,
			"pi.tool.result_size_bytes": toolResultSizeBytes(finalized.result),
			"pi.tool.outcome":
				signal?.aborted && finalized.isError ? "aborted" : finalized.isError ? "error" : "completed",
		});
		if (finalized.isError) span?.setStatus({ status: "error" });
		return finalized;
	};
	const attributes = toolStartAttributes(toolCall, config);
	const result =
		config.telemetryContext && attributes
			? startHarnessSpan(config.telemetryContext, "pi.harness.tool", attributes, execute)
			: execute();
	void result.catch((error) => {
		rejectPreparation(error);
	});
	return { preparation, release, result };
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
