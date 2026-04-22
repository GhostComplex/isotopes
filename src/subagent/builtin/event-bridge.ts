// src/subagent/builtin/event-bridge.ts — Bridge SDK AgentEvent stream to SubagentEvent stream

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { SubagentEvent } from "../types.js";

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
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          buffer += ame.delta;
        }
        break;
      }
      case "turn_end": {
        const text = buffer.trim();
        if (text.length > 0) yield { type: "message", content: text };
        buffer = "";
        break;
      }
      case "tool_execution_start":
        yield {
          type: "tool_use",
          toolName: event.toolName,
          toolInput: event.args,
        };
        break;
      case "tool_execution_end": {
        const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        yield {
          type: "tool_result",
          toolResult: output,
          ...(event.isError ? { error: "tool error" } : {}),
        };
        break;
      }
      case "agent_end": {
        const trailing = buffer.trim();
        if (trailing.length > 0) yield { type: "message", content: trailing };
        buffer = "";
        const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
        const errMsg = (lastAssistant as unknown as { errorMessage?: string })?.errorMessage;
        if (errMsg) {
          yield { type: "error", error: errMsg };
          yield { type: "done", exitCode: 1 };
        } else {
          yield { type: "done", exitCode: 0 };
        }
        endedNormally = true;
        break;
      }
    }
  }

  if (!endedNormally) {
    const trailing = buffer.trim();
    if (trailing.length > 0) yield { type: "message", content: trailing };
    yield { type: "done", exitCode: 0 };
  }
}
