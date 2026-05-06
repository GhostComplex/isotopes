// Inline tags an agent may emit in chat output:
//   [[reply_to_current]]      — reply to the message that triggered this turn
//   [[reply_to: <message-id>]] — reply to a specific message id

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

export interface ResolvedReply {
  stripped: string;
  /** Undefined when the agent didn't request a reply for this chunk. */
  replyToId?: string;
}

/** Stateless — call once per outbound chunk. */
export function parseReplyDirective(
  text: string,
  triggerMessageId?: string,
): ResolvedReply {
  let useCurrent = false;
  let explicitReplyToId: string | undefined;

  const re = new RegExp(REPLY_TAG_RE.source, REPLY_TAG_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
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
  const inline = new RegExp(REPLY_TAG_RE.source, REPLY_TAG_RE.flags);
  const stripped = text
    .replace(aloneOnLine, "$1")
    .replace(inline, "")
    .replace(/[ \t]+\n/g, "\n");

  const replyToId = explicitReplyToId ?? (useCurrent ? triggerMessageId : undefined);
  return replyToId !== undefined ? { stripped, replyToId } : { stripped };
}

// Pass via RunRequest.extraSystemPrompt from any chat transport so the agent
// learns the tag vocabulary. Tags are honored only on transports that
// translate replyToId into a native reply primitive.
export const REPLY_DIRECTIVE_PROMPT = `# Chat Output Directives

When you reply on a chat surface, you may include the following inline tags
in your message to request delivery metadata. Tags are stripped from the
user-visible text and are only honored on channels that support the
underlying feature; channels without support silently ignore them.

- \`[[reply_to_current]]\` — render this message as a native reply to the
  message that triggered the current turn. Prefer this form.
- \`[[reply_to: <message-id>]]\` — render this message as a native reply to
  a specific message id. Use only when the id was explicitly given to you
  (by the user or by a tool result).

Place the tag at the start of your response, before any other text.
Whitespace inside the brackets is allowed. Tags are channel-agnostic — each
transport (Discord, Telegram, Feishu, …) renders them in the platform's native
reply / quote primitive where available.`;
