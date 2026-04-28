// src/transport/session-key-codec.ts — Composes / parses runtime session ids.
//
// Format: "<transport>:<channel>:<agentId>"
//   - transport: short scheme tag (no colons)
//   - channel:   opaque transport-specific channel id (no colons)
//   - agentId:   agent id (may contain colons; takes the rest of the string)
//
// Examples:
//   discord:123456789:main
//   tui:cli:eous
//   http:s1:bot

export interface SessionKeyParts {
  transport: string;
  channel: string;
  agentId: string;
}

export function composeSessionId(parts: SessionKeyParts): string {
  assertNoColon(parts.transport, "transport");
  assertNoColon(parts.channel, "channel");
  assertNonEmpty(parts.agentId, "agentId");
  return `${parts.transport}:${parts.channel}:${parts.agentId}`;
}

export function parseSessionId(sessionId: string): SessionKeyParts | undefined {
  const i1 = sessionId.indexOf(":");
  if (i1 <= 0) return undefined;
  const i2 = sessionId.indexOf(":", i1 + 1);
  if (i2 <= i1 + 1) return undefined;
  const transport = sessionId.slice(0, i1);
  const channel = sessionId.slice(i1 + 1, i2);
  const agentId = sessionId.slice(i2 + 1);
  if (!agentId) return undefined;
  return { transport, channel, agentId };
}

function assertNoColon(value: string, field: string): void {
  assertNonEmpty(value, field);
  if (value.includes(":")) {
    throw new Error(`session-key codec: ${field} must not contain ':' (got "${value}")`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value) throw new Error(`session-key codec: ${field} must be non-empty`);
}
