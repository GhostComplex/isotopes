// Recognizes two inline tags in agent output text:
//   [[reply_to_current]]      — reply to the message that triggered this turn
//   [[reply_to: <message-id>]] — reply to any specific message by ID
//
// Tags are channel-agnostic; transports that support a native reply primitive
// (Discord, Telegram, Feishu, …) translate the resolved id into their native
// API call. Transports that don't support replies ignore the id.

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

export interface ResolvedReply {
  /** Text with all directive tags stripped. */
  stripped: string;
  /** Reply target id if the agent requested one. Undefined for plain send. */
  replyToId?: string;
}

/**
 * Parse + strip reply directives from a chunk of agent output.
 *
 * Resolution: an explicit `[[reply_to: <id>]]` wins; otherwise
 * `[[reply_to_current]]` resolves to triggerMessageId; otherwise no reply.
 *
 * Stateless — call once per outbound chunk.
 */
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

  // Two-pass strip: drop directive-only lines entirely, then strip inline
  // remainders. Tail whitespace before newlines is collapsed.
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

/**
 * System-prompt addendum that teaches the LLM how to use reply directives.
 * Transports that originate runs from a chat surface should pass this string
 * via RunRequest.systemPromptAddendum so the agent learns the syntax.
 */
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
