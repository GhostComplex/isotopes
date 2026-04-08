// src/core/session-keys.ts — Shared session key builder
// Standardises the session key format across all transports.
//
// Format: {transport}:{botId}:{scope}:{scopeId}:{agentId}
//
// Examples:
//   discord:bot-123:channel:456:default
//   discord:bot-123:thread:789:default
//   discord:bot-123:dm:user-1:default
//   feishu:app123:dm:user456:agent1
//   feishu:app123:group:oc_group789:agent1

export type SessionScope = "channel" | "thread" | "dm" | "group";

/**
 * Build a deterministic, colon-delimited session key.
 *
 * Every transport uses the same format so that session keys are
 * consistent, collision-free, and easy to parse.
 */
export function buildSessionKey(
  transport: string,
  botId: string,
  scope: SessionScope,
  scopeId: string,
  agentId: string,
): string {
  return `${transport}:${botId}:${scope}:${scopeId}:${agentId}`;
}
