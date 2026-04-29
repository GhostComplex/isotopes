// src/core/agent-events.ts — Shared AgentEvent type guard

import type { AgentEvent } from "@mariozechner/pi-agent-core";

export const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

export function isAgentEvent(e: { type: string }): e is AgentEvent {
  return AGENT_EVENT_TYPES.has(e.type);
}
