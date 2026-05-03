// src/silent-reply.ts — Silent reply token detection and stripping.
//
// Agents may emit one of these tokens to signal that the current turn should
// produce no outbound message. Two tokens are recognized:
//
//   - NO_REPLY      generic "stay silent this turn"
//   - HEARTBEAT_OK  liveness ack for heartbeat polls
//
// Detection has several flavors because real models do not always emit the
// token cleanly:
//
//   exact      — entire response is the token (case-insensitive, optional
//                surrounding whitespace). The strictest form; used to suppress
//                outbound delivery without risk of swallowing a substantive
//                reply that merely mentions the token.
//   envelope   — model wrapped the token in `{"action": "NO_REPLY"}` JSON.
//   payload    — exact OR envelope. The default check for "should we suppress?"
//   leading /  — the model started or ended its reply with the token but added
//   trailing     other text. Strip helpers expose the remaining content so
//                callers can decide whether to deliver the rest.
//   prefix     — partial token observed during streaming (e.g. "NO" or "NO_R")
//                where the visible chunk so far is consistent with the model
//                being in the middle of emitting a silent token. Used to
//                suppress typing indicators / partial UI updates.

const ESCAPE_REGEX_PATTERN = /[.*+?^${}()|[\]\\]/g;

function escapeForRegex(input: string): string {
  return input.replace(ESCAPE_REGEX_PATTERN, "\\$&");
}

export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

const exactRegexCache = new Map<string, RegExp>();
const trailingRegexCache = new Map<string, RegExp>();
const leadingRegexCache = new Map<string, RegExp>();
const leadingAttachedRegexCache = new Map<string, RegExp>();

function getExactRegex(token: string): RegExp {
  const cached = exactRegexCache.get(token);
  if (cached) return cached;
  const regex = new RegExp(`^\\s*${escapeForRegex(token)}\\s*$`, "i");
  exactRegexCache.set(token, regex);
  return regex;
}

function getTrailingRegex(token: string): RegExp {
  const cached = trailingRegexCache.get(token);
  if (cached) return cached;
  // Match the token at end-of-string, preceded by whitespace, asterisks, or
  // start-of-string. The asterisk allowance handles models that bold the token
  // (e.g. "...done. **NO_REPLY**").
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escapeForRegex(token)}\\s*$`, "i");
  trailingRegexCache.set(token, regex);
  return regex;
}

function getLeadingRegex(token: string): RegExp {
  const cached = leadingRegexCache.get(token);
  if (cached) return cached;
  // One or more leading occurrences of the token, each followed by optional
  // whitespace. Used to clean up runs of "NO_REPLY NO_REPLY <real reply>".
  const regex = new RegExp(`^(?:\\s*${escapeForRegex(token)})+\\s*`, "i");
  leadingRegexCache.set(token, regex);
  return regex;
}

function getLeadingAttachedRegex(token: string): RegExp {
  const cached = leadingAttachedRegexCache.get(token);
  if (cached) return cached;
  // Leading token(s) where the final occurrence is glued directly to a letter
  // or digit (e.g. "NO_REPLYhello"). Punctuation-leading content like
  // "NO_REPLY: actually..." is intentionally excluded — those look like the
  // model commenting on the token rather than emitting it.
  const regex = new RegExp(
    `^\\s*(?:${escapeForRegex(token)}\\s+)*${escapeForRegex(token)}(?=[\\p{L}\\p{N}])`,
    "iu",
  );
  leadingAttachedRegexCache.set(token, regex);
  return regex;
}

/**
 * True iff `text`, after trimming, exactly equals `token` (case-insensitive).
 *
 * This is the strict form. Substantive replies that merely contain or end
 * with the token are NOT matched — embedding suppression there would silently
 * swallow legitimate messages that happen to discuss the token.
 */
export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) return false;
  return getExactRegex(token).test(text);
}

type SilentReplyEnvelope = { action?: unknown };

/**
 * True iff `text` is exactly the JSON envelope `{"action": "<token>"}`.
 *
 * Some models wrap the token in JSON when the prompt nudges them toward
 * structured output. The envelope must contain only the `action` key and
 * its value must equal `token`.
 */
export function isSilentReplyEnvelopeText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(token)) {
    return false;
  }
  let parsed: SilentReplyEnvelope;
  try {
    parsed = JSON.parse(trimmed) as SilentReplyEnvelope;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  return (
    keys.length === 1 &&
    keys[0] === "action" &&
    typeof parsed.action === "string" &&
    parsed.action.trim() === token
  );
}

/**
 * Default "should we suppress this response?" check. Matches the strict text
 * form OR the JSON envelope form.
 */
export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return isSilentReplyText(text, token) || isSilentReplyEnvelopeText(text, token);
}

/**
 * Strip a trailing token (and its preceding whitespace / bold asterisks) and
 * return the cleaned text. If the result is empty, the entire response should
 * be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getTrailingRegex(token), "").trim();
}

/**
 * Strip one or more leading tokens and return the cleaned text. Handles cases
 * like `"NO_REPLY actually here is the reply"` or
 * `"NO_REPLYhello"` where the model glued the token to following content.
 */
export function stripLeadingSilentToken(
  text: string,
  token: string = SILENT_REPLY_TOKEN,
): string {
  return text.replace(getLeadingRegex(token), "").trim();
}

/**
 * True iff `text` starts with the token glued directly to visible content
 * (letter or digit), e.g. `"NO_REPLYhello"`. Used to detect that a streaming
 * chunk has crossed from the token into real content and the prefix needs
 * stripping.
 */
export function startsWithSilentToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) return false;
  return getLeadingAttachedRegex(token).test(text);
}

/**
 * True iff `text` looks like the model has begun emitting a silent token but
 * has not finished — e.g. the streamed chunk so far is `"NO"` or `"NO_R"`.
 *
 * Used by streaming consumers (typing indicators, partial UI updates) to hold
 * off rendering until enough characters arrive to disambiguate.
 *
 * Guards:
 *   - the visible content must be all-uppercase (otherwise natural-language
 *     "No, I think..." would be matched)
 *   - allowed characters are restricted to A–Z and underscore
 *   - the bare two-letter prefix `"NO"` is only treated as a partial token
 *     for `SILENT_REPLY_TOKEN`, never for arbitrary tokens, since `"NO"` is
 *     a common standalone English word
 */
export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  if (trimmed !== trimmed.toUpperCase()) return false;
  const normalized = trimmed.toUpperCase();
  if (normalized.length < 2) return false;
  if (/[^A-Z_]/.test(normalized)) return false;
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) return false;
  if (normalized.includes("_")) return true;
  // For tokens without an underscore we require an underscore to appear before
  // we treat the prefix as silent — otherwise short uppercase fragments like
  // "HE" would match HEARTBEAT_OK and suppress unrelated output. The literal
  // two-letter "NO" is the one allowed exception because NO_REPLY streaming
  // routinely emits it as a transient prefix.
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}
