// src/core/agent-runner.ts — Shared agent event loop
// Iterates over agent.prompt() and collects the response, handling errors uniformly.

import { textContent, type AgentEvent, type AgentInstance, type Message, type SessionStore } from "./types.js";
import type { Logger } from "./logger.js";

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

/**
 * Callback invoked for every AgentEvent (text_delta, tool_call, tool_result, etc.).
 *
 * Transports that need visibility into events beyond text deltas (e.g. WebChat
 * SSE streaming) can use this to forward all events to the client.
 */
export type OnEvent = (event: AgentEvent) => void | Promise<void>;

export interface RunAgentOptions {
  agent: AgentInstance;
  input: string | Message[];
  sessionId: string;
  sessionStore: SessionStore;
  log: Logger;
  /** Optional callback fired after each text_delta */
  onTextDelta?: OnTextDelta;
  /** Optional callback fired for every agent event */
  onEvent?: OnEvent;
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
  const { agent, input, sessionId, sessionStore, log, onTextDelta, onEvent } = opts;

  let responseText = "";
  let errorMessage: string | null = null;

  for await (const event of agent.prompt(input)) {
    if (onEvent) {
      await onEvent(event);
    }

    if (event.type === "text_delta") {
      responseText += event.text;
      if (onTextDelta) {
        await onTextDelta(responseText);
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
