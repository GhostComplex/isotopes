// src/transports/reply-directive.ts — Inline reply directive parser + resolver
//
// Recognizes two inline tags in agent output text:
//   [[reply_to_current]]      — reply to the message that triggered this turn
//   [[reply_to: <message-id>]] — reply to any specific message by ID

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

/**
 * How the trigger message id should be applied as a Discord reply marker.
 *
 * - `"off"` (default): never attach a reply marker by default. The agent can
 *   still opt in per-response via inline `[[reply_to_current]]` /
 *   `[[reply_to: <id>]]` directives.
 * - `"first"`: attach the trigger message as a reply marker on the first
 *   outbound chunk only.
 * - `"all"`: attach on every outbound chunk.
 *
 * Inline directives in agent text always override this per-response.
 */
export type ReplyToMode = "off" | "first" | "all";

export interface ParsedReplyDirective {
  /** Text with all directive tags removed. */
  stripped: string;
  /** Last `[[reply_to: <id>]]` value found, if any. */
  explicitReplyToId?: string;
  /** True if any `[[reply_to_current]]` tag was found. */
  useCurrent: boolean;
}

/** Parse and strip reply directives from a text fragment. */
export function parseReplyDirective(text: string): ParsedReplyDirective {
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

  // Two-pass strip:
  // 1. If the directive sits alone on its own line (only whitespace around it,
  //    followed by a newline), eat the whole line so we don't leave a blank
  //    line behind.
  // 2. Otherwise, just remove the tag itself and let the surrounding text be.
  // Then collapse any trailing whitespace before newlines that the strip might
  // have left behind.
  const aloneOnLine = new RegExp(
    `(^|\\n)[ \\t]*(?:${REPLY_TAG_RE.source})[ \\t]*\\n`,
    REPLY_TAG_RE.flags,
  );
  const inline = new RegExp(REPLY_TAG_RE.source, REPLY_TAG_RE.flags);
  const stripped = text
    .replace(aloneOnLine, "$1")
    .replace(inline, "")
    .replace(/[ \t]+\n/g, "\n");

  return { stripped, explicitReplyToId, useCurrent };
}

export interface ReplyResolverOptions {
  /** Default reply policy from config. */
  mode: ReplyToMode;
  /** ID of the message that triggered this response. */
  triggerMessageId?: string;
}

export interface ResolvedChunk {
  /** ID to use as the Discord reply target, or undefined for plain send. */
  replyToId?: string;
  /** Text with directives stripped. */
  stripped: string;
}

/**
 * Build a stateful resolver: call `resolve(text)` once per outbound chunk to
 * get back the stripped text and the optional reply target.
 *
 * Single-use across the response: once any chunk gets a reply marker — from
 * an inline directive, from `mode: "first"`, or from `mode: "all"` — no
 * later chunk in the same response will get one. `mode: "all"` differs from
 * `mode: "first"` only in that it stamps every chunk *until* an inline
 * directive consumes the slot; an inline directive on chunk N ends the
 * stamping for chunks N+1 onward.
 */
export function createReplyResolver(opts: ReplyResolverOptions) {
  let used = false;

  return function resolve(text: string): ResolvedChunk {
    const parsed = parseReplyDirective(text);

    // Inline directive wins over config. Single-use across the response.
    if (!used) {
      if (parsed.explicitReplyToId) {
        used = true;
        return { replyToId: parsed.explicitReplyToId, stripped: parsed.stripped };
      }
      if (parsed.useCurrent && opts.triggerMessageId) {
        used = true;
        return { replyToId: opts.triggerMessageId, stripped: parsed.stripped };
      }
    }

    // Config-based default. Both modes honor `used` so an inline directive
    // earlier in the response cleanly takes over the reply slot.
    if (opts.mode === "all" && opts.triggerMessageId && !used) {
      return { replyToId: opts.triggerMessageId, stripped: parsed.stripped };
    }
    if (opts.mode === "first" && opts.triggerMessageId && !used) {
      used = true;
      return { replyToId: opts.triggerMessageId, stripped: parsed.stripped };
    }

    return { stripped: parsed.stripped };
  };
}
