// src/gateway/session-keys.ts — Shared session key builder
// Format: {channel}:{botId}:{scope}:{scopeId}

export type SessionScope = "channel" | "thread" | "dm" | "group";

export function buildSessionKey(
  channel: string,
  botId: string,
  scope: SessionScope,
  scopeId: string,
): string {
  return `${channel}:${botId}:${scope}:${scopeId}`;
}
