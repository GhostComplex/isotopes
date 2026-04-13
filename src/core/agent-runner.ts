// src/core/agent-runner.ts — Shared agent event loop
// Iterates over agent.prompt() and collects the response, handling errors uniformly.

import { textContent, type AgentInstance, type Message, type SessionStore } from "./types.js";
import type { Logger } from "./logger.js";
import type { UsageTracker } from "./usage-tracker.js";

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
  /** Optional callback fired after each text_delta */
  onTextDelta?: OnTextDelta;
  /** Optional usage tracker for per-session/global accumulation */
  usageTracker?: UsageTracker;
  /** Called after turn_end events to check for pending messages */
  onToolComplete?: () => Promise<string | null>;
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
  const { agent, input, sessionId, sessionStore, log, onTextDelta, usageTracker, onToolComplete } = opts;

  let responseText = "";
  let errorMessage: string | null = null;

  for await (const event of agent.prompt(input)) {
    if (event.type === "text_delta") {
      responseText += event.text;
      if (onTextDelta) {
        await onTextDelta(responseText);
      }
    } else if (event.type === "turn_end") {
      if (usageTracker && event.usage) {
        usageTracker.record(sessionId, event.usage);
      }

      // Check for pending messages after tool calls complete
      if (onToolComplete) {
        const pendingContext = await onToolComplete();
        if (pendingContext) {
          log.debug(`Injecting pending messages via steer()`);
          agent.steer({ role: "user", content: textContent(pendingContext) });
        }
      }
    } else if (event.type === "agent_end") {
      // Store final assistant message
      if (responseText) {
        await sessionStore.addMessage(sessionId, {
          role: "assistant",
          content: textContent(responseText),
          timestamp: Date.now(),
        });
      }

      if (event.stopReason === "error") {
        const msg = event.errorMessage ?? "Unknown agent error";
        log.error(`Agent ended with error: ${msg}`);
        errorMessage = msg;
      }
    }
  }

  return { responseText, errorMessage };
}
