// src/core/agent-runner.ts — Shared agent event loop
// Iterates over agent.prompt() and collects the response, handling errors uniformly.

import {
  textContent,
  type AgentInstance,
  type Message,
  type MessageContentBlock,
  type SessionStore,
  type ToolCallContentBlock,
} from "./types.js";
import type { Logger } from "./logger.js";
import type { UsageTracker } from "./usage-tracker.js";
import type { HookRegistry } from "../plugins/hooks.js";

/** Max chars to keep in a persisted tool_result output. Longer outputs are truncated. */
export const MAX_TOOL_RESULT_CHARS = 16_000;

function truncateToolResult(output: string): string {
  if (output.length <= MAX_TOOL_RESULT_CHARS) return output;
  const head = output.slice(0, MAX_TOOL_RESULT_CHARS);
  return `${head}\n...[truncated ${output.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

/** Result of running an agent prompt to completion */
export interface AgentRunResult {
  /** Accumulated text from text_delta events */
  responseText: string;
  /** Error message if agent_end had stopReason === "error" */
  errorMessage: string | null;
}

/**
 * Callback invoked on each text_delta event.
 *
 * Transports can use this to implement streaming (e.g. updating a Discord
 * message as chunks arrive). If not provided, deltas are silently accumulated.
 */
export type OnTextDelta = (currentText: string) => void | Promise<void>;

export interface RunAgentOptions {
  agent: AgentInstance;
  input: string | Message[];
  sessionId: string;
  sessionStore: SessionStore;
  log: Logger;
  onTextDelta?: OnTextDelta;
  usageTracker?: UsageTracker;
  onToolComplete?: () => Promise<string | null>;
  agentId?: string;
  hooks?: HookRegistry;
}

/**
 * Run an agent prompt to completion, collecting the full response text.
 *
 * This is the shared event-loop extracted from DiscordTransport.runAgentAndRespond
 * and FeishuTransport.runAgentAndReply. Both transports follow the same pattern:
 *
 *   1. Iterate over agent.prompt(input)
 *   2. Accumulate text_delta events into responseText
 *   3. On agent_end, persist the assistant message and capture any error
 *
 * Transport-specific concerns (typing indicators, streaming edits, chunking)
 * stay in the transport layer via the onTextDelta callback.
 */
export async function runAgentLoop(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, input, sessionId, sessionStore, log, onTextDelta, usageTracker, onToolComplete, agentId, hooks } = opts;

  if (hooks && agentId) {
    await hooks.emit("message_received", {
      agentId,
      sessionId,
      message: typeof input === "string"
        ? { role: "user", content: textContent(input) }
        : input[input.length - 1],
    });
  }

  let responseText = "";
  let errorMessage: string | null = null;

  // Per-turn persistence state. Each LLM turn may emit text deltas and any
  // number of tool_call / tool_result events. At turn_end we flush: one
  // assistant message (text + tool_call blocks) followed by one tool_result-
  // role message per tool result, preserving wire-format ordering.
  let turnText = "";
  let turnToolCalls: ToolCallContentBlock[] = [];
  let turnToolResults: Message[] = [];
  const toolNameById = new Map<string, string>();

  const flushTurn = async (): Promise<void> => {
    if (turnText || turnToolCalls.length > 0) {
      const content: MessageContentBlock[] = [];
      if (turnText) content.push({ type: "text", text: turnText });
      content.push(...turnToolCalls);
      await sessionStore.addMessage(sessionId, {
        role: "assistant",
        content,
        timestamp: Date.now(),
      });
    }
    for (const msg of turnToolResults) {
      await sessionStore.addMessage(sessionId, msg);
    }
    turnText = "";
    turnToolCalls = [];
    turnToolResults = [];
  };

  for await (const event of agent.prompt(input)) {
    if (event.type === "text_delta") {
      responseText += event.text;
      turnText += event.text;
      if (onTextDelta) {
        await onTextDelta(responseText);
      }
    } else if (event.type === "tool_call") {
      log.debug(`Tool call: ${event.name}`, { id: event.id });
      toolNameById.set(event.id, event.name);
      turnToolCalls.push({
        type: "tool_call",
        id: event.id,
        name: event.name,
        input: event.args,
      });
    } else if (event.type === "tool_result") {
      log.debug(`Tool result: ${event.id}`);
      const toolName = toolNameById.get(event.id);
      turnToolResults.push({
        role: "tool_result",
        content: [{
          type: "tool_result",
          output: truncateToolResult(event.output),
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          toolCallId: event.id,
          ...(toolName ? { toolName } : {}),
        }],
        timestamp: Date.now(),
        metadata: { toolCallId: event.id, ...(toolName ? { toolName } : {}) },
      });
    } else if (event.type === "turn_end") {
      if (usageTracker && event.usage) {
        usageTracker.record(sessionId, event.usage);
      }

      // Persist this turn's assistant message + tool_result messages.
      await flushTurn();

      // Check for pending messages after tool calls complete
      if (onToolComplete) {
        const pendingContext = await onToolComplete();
        if (pendingContext) {
          log.debug(`Injecting pending messages via steer()`);
          agent.steer({ role: "user", content: textContent(pendingContext) });
        }
      }
    } else if (event.type === "agent_end") {
      // Defensive flush — if the run ended without a final turn_end, persist
      // whatever text/tool blocks we accumulated so nothing is silently dropped.
      await flushTurn();

      if (hooks && agentId && responseText) {
        await hooks.emit("message_sending", {
          agentId,
          sessionId,
          message: { role: "assistant", content: textContent(responseText) },
        });
      }

      if (event.stopReason === "error") {
        const msg = event.errorMessage ?? "Unknown agent error";
        log.error(`Agent ended with error: ${msg}`);
        errorMessage = msg;
      }

      if (hooks && agentId) {
        await hooks.emit("agent_end", { agentId, stopReason: event.stopReason });
      }
    }
  }

  return { responseText, errorMessage };
}
