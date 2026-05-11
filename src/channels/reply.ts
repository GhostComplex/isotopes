// Inline tags an agent may emit in chat output:
//   [[reply_to_current]]      — reply to the message that triggered this turn
//   [[reply_to: <message-id>]] — reply to a specific message id

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

interface ResolvedReply {
  stripped: string;
  replyToId?: string;
}

/** Stateless — call once per outbound chunk. */
export function parseReply(
  text: string,
  triggerMessageId?: string,
): ResolvedReply {
  let useCurrent = false;
  let explicitReplyToId: string | undefined;

  for (const m of text.matchAll(REPLY_TAG_RE)) {
    if (m[1] === undefined) {
      useCurrent = true;
    } else {
      explicitReplyToId = m[1].trim();
    }
  }

  // Drop directive-only lines entirely; strip inline remainders.
  const aloneOnLine = new RegExp(
    `(^|\\n)[ \\t]*(?:${REPLY_TAG_RE.source})[ \\t]*\\n`,
    REPLY_TAG_RE.flags,
  );
  const stripped = text
    .replace(aloneOnLine, "$1")
    .replace(REPLY_TAG_RE, "")
    .replace(/[ \t]+\n/g, "\n");

  const replyToId = explicitReplyToId ?? (useCurrent ? triggerMessageId : undefined);
  return replyToId !== undefined ? { stripped, replyToId } : { stripped };
}

// Pass via RunRequest.extraSystemPrompt from any chat channel so the agent
// learns the tag vocabulary. Tags are honored only on channels that
// translate replyToId into a native reply primitive.
export const REPLY_PROMPT = `# Chat Reply Tags

Optionally start your message with one of these to render it as a native
reply (the tag is stripped from user-visible text; channels without reply
support ignore it):

- \`[[reply_to_current]]\` — reply to the message that triggered this turn.
  **Use sparingly.** Only when the channel has multiple ongoing
  conversations and your message would be ambiguous without quoting the
  specific trigger. In a DM, focused thread, or quiet channel, do NOT use
  this — a plain message reads more naturally.
- \`[[reply_to: <message-id>]]\` — reply to a specific id (only when an
  explicit id was given to you, e.g. via channel history).

Whitespace inside brackets is allowed. Default behavior (no tag) is a
plain message — prefer that.`;
