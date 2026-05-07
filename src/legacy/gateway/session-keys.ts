// src/gateway/session-keys.ts — Shared session key builder
// Format: {transport}:{botId}:{scope}:{scopeId}

export type SessionScope = "channel" | "thread" | "dm" | "group";

export function buildSessionKey(
  transport: string,
  botId: string,
  scope: SessionScope,
  scopeId: string,
): string {
  return `${transport}:${botId}:${scope}:${scopeId}`;
}
