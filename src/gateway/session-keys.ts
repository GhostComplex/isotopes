// src/gateway/session-keys.ts — Shared session key builder
// Standardises the session key format across all transports.
//
// Format: {transport}:{botId}:{scope}:{scopeId}
//
// Examples:
//   discord:bot-123:channel:456
//   discord:bot-123:thread:789
//   discord:bot-123:dm:user-1
//
// Keys describe WHERE the conversation lives — they do NOT encode WHICH
// agent owns it. Agent ownership is the (agentId, sessionKey) pair, with
// agentId routed by binding.
//
// Constraint: keys appear in URL path segments. Avoid '/', '?', '#'.

export type SessionScope = "channel" | "thread" | "dm" | "group";

/** Build a deterministic, colon-delimited session key. */
export function buildSessionKey(
  transport: string,
  botId: string,
  scope: SessionScope,
  scopeId: string,
): string {
  return `${transport}:${botId}:${scope}:${scopeId}`;
}
