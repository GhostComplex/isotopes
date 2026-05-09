// src/gateway/mention.ts — Mention detection for message handling
// Transport-agnostic: determines whether a bot should respond based on mention rules.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context needed to evaluate whether a message should be handled */
export interface MentionContext {
  /** Whether the bot was @mentioned in the message */
  isMentioned: boolean;
  /** Whether this is a DM (no guild/group) */
  isDM: boolean;
  /** Whether @mention is required to respond (default: true) */
  requireMention?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a bot should respond to a message based on mention rules.
 *
 * Rules:
 *   1. DMs: always respond (no mention required)
 *   2. requireMention=false: always respond
 *   3. requireMention=true (default): only respond if @mentioned
 */
export function shouldRespondToMessage(ctx: MentionContext): boolean {
  if (ctx.isDM) return true;

  const requireMention = ctx.requireMention ?? true;
  if (!requireMention) return true;

  return ctx.isMentioned;
}
