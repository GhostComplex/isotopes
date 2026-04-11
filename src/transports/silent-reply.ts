// src/transports/silent-reply.ts — Silent reply token detection
// Agents can return these tokens to suppress outbound messages while still
// logging internally. Used for heartbeat checks and explicit "no reply" signals.

/** Tokens that suppress outbound delivery when returned by an agent. */
export const SILENT_REPLY_TOKENS = ["[NO_REPLY]", "[HEARTBEAT_OK]"] as const;

export type SilentReplyToken = (typeof SILENT_REPLY_TOKENS)[number];

/**
 * Check whether the agent's full response text is a silent reply.
 *
 * A response is considered silent when its trimmed content exactly matches
 * one of the known tokens. If the agent returns additional text alongside
 * a token, the response is treated as a normal reply — the token must be
 * the *entire* response.
 */
export function isSilentReply(content: string): boolean {
  const trimmed = content.trim();
  return (SILENT_REPLY_TOKENS as readonly string[]).includes(trimmed);
}
