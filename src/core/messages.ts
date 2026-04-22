// src/core/messages.ts — Helper functions for constructing AgentMessages
// These create properly-typed user/assistant/toolResult messages compatible
// with the pi-agent-core AgentMessage union.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Create a user message with text content. */
export function userMessage(text: string, timestamp?: number): AgentMessage {
  return { role: "user", content: text, timestamp: timestamp ?? Date.now() };
}

/** Create an assistant message with text content. */
export function assistantMessage(text: string, timestamp?: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: timestamp ?? Date.now(),
  } as unknown as AgentMessage;
}

/** Create a toolResult message. */
export function toolResultMessage(
  output: string,
  toolCallId: string,
  toolName: string,
  opts?: { isError?: boolean; timestamp?: number },
): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text: output }],
    toolCallId,
    toolName,
    ...(opts?.isError !== undefined ? { isError: opts.isError } : {}),
    timestamp: opts?.timestamp ?? Date.now(),
  } as unknown as AgentMessage;
}

/** Extract plain text from an AgentMessage's content. */
export function messageText(msg: AgentMessage): string {
  const m = msg as unknown as { content?: unknown };
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b: Record<string, unknown>) => {
        if (typeof b.text === "string") return b.text;
        if (typeof b.output === "string") return b.output;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Loosely-typed accessor for AgentMessage properties (avoids `as any` in tests). */
export function msgField<T = unknown>(msg: AgentMessage, field: string): T {
  return (msg as unknown as Record<string, unknown>)[field] as T;
}

/** Extract stopReason + errorMessage from the last assistant message in an agent_end event. */
export function getAgentEndMeta(messages: AgentMessage[]): { stopReason?: string; errorMessage?: string } {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return {};
  return {
    stopReason: msgField<string | undefined>(last, "stopReason"),
    errorMessage: msgField<string | undefined>(last, "errorMessage"),
  };
}

/** Extract usage from an assistant message (SDK turn_end.message). */
export function getUsage(msg: AgentMessage | undefined): unknown {
  if (!msg || !("usage" in msg)) return undefined;
  return (msg as unknown as { usage: unknown }).usage;
}
