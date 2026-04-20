// src/subagent/builtin/event-bridge.ts — Bridge AgentEvent stream to SubagentEvent stream
// AgentEvent (pi-mono) is delta-oriented; SubagentEvent is message-oriented. The bridge
// buffers text deltas across a turn and emits a single "message" event at turn_end.

import type { AgentEvent } from "../../core/types.js";
import type { SubagentEvent } from "../types.js";

/**
 * Translate a stream of {@link AgentEvent}s from {@link AgentInstance.prompt}
 * into a stream of {@link SubagentEvent}s used by the subagent backend.
 *
 * - text_delta: buffered, flushed as "message" on turn_end (only if non-empty).
 * - tool_call → tool_use; tool_result → tool_result.
 * - agent_end → "done" with exitCode 0 (or 1 if `errorMessage` set).
 * - error → "error" + "done" exitCode 1.
 */
export async function* bridgeAgentEvents(
  events: AsyncIterable<AgentEvent>,
): AsyncGenerator<SubagentEvent, void, void> {
  let buffer = "";
  let endedNormally = false;

  for await (const event of events) {
    switch (event.type) {
      case "turn_start":
        buffer = "";
        break;
      case "text_delta":
        buffer += event.text;
        break;
      case "turn_end": {
        const text = buffer.trim();
        if (text.length > 0) yield { type: "message", content: text };
        buffer = "";
        break;
      }
      case "tool_call":
        yield {
          type: "tool_use",
          toolName: event.name,
          toolInput: event.args,
        };
        break;
      case "tool_result":
        yield {
          type: "tool_result",
          toolResult: event.output,
          ...(event.isError ? { error: "tool error" } : {}),
        };
        break;
      case "agent_end": {
        const trailing = buffer.trim();
        if (trailing.length > 0) yield { type: "message", content: trailing };
        buffer = "";
        if (event.errorMessage) {
          yield { type: "error", error: event.errorMessage };
          yield { type: "done", exitCode: 1 };
        } else {
          yield { type: "done", exitCode: 0 };
        }
        endedNormally = true;
        break;
      }
      case "error":
        yield { type: "error", error: event.error.message };
        yield { type: "done", exitCode: 1 };
        endedNormally = true;
        break;
    }
  }

  if (!endedNormally) {
    const trailing = buffer.trim();
    if (trailing.length > 0) yield { type: "message", content: trailing };
    yield { type: "done", exitCode: 0 };
  }
}
