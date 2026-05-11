// Detection + stripping for silent-reply tokens (NO_REPLY, HEARTBEAT_OK).
// Models do not always emit the token cleanly, so several detection flavors
// (exact, JSON envelope, leading/trailing strip, streaming prefix) are
// exposed for callers to compose.

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
  // Allow `*+` as a separator so bolded forms like `**NO_REPLY` are stripped.
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escapeForRegex(token)}\\s*$`, "i");
  trailingRegexCache.set(token, regex);
  return regex;
}

function getLeadingRegex(token: string): RegExp {
  const cached = leadingRegexCache.get(token);
  if (cached) return cached;
  const regex = new RegExp(`^(?:\\s*${escapeForRegex(token)})+\\s*`, "i");
  leadingRegexCache.set(token, regex);
  return regex;
}

function getLeadingAttachedRegex(token: string): RegExp {
  const cached = leadingAttachedRegexCache.get(token);
  if (cached) return cached;
  // Glued to a letter/digit only; punctuation (`NO_REPLY: ...`) reads as the
  // model talking about the token, not emitting it.
  const regex = new RegExp(
    `^\\s*(?:${escapeForRegex(token)}\\s+)*${escapeForRegex(token)}(?=[\\p{L}\\p{N}])`,
    "iu",
  );
  leadingAttachedRegexCache.set(token, regex);
  return regex;
}

/** Strict: trimmed text equals `token` (case-insensitive). Substantive replies
 *  that merely mention the token are not matched. */
export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) return false;
  return getExactRegex(token).test(text);
}

type SilentReplyEnvelope = { action?: unknown };

/** Match `{"action": "<token>"}` JSON-wrapped form. Single-key envelope only. */
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

/** Default suppression check: exact text or JSON envelope. */
export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return isSilentReplyText(text, token) || isSilentReplyEnvelopeText(text, token);
}

/** Strip trailing token; empty result means treat the whole reply as silent. */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getTrailingRegex(token), "").trim();
}

/** Strip one or more leading tokens, including the glued form `NO_REPLYhello`. */
export function stripLeadingSilentToken(
  text: string,
  token: string = SILENT_REPLY_TOKEN,
): string {
  return text.replace(getLeadingRegex(token), "").trim();
}

/** True when text begins with the token glued directly to a letter/digit. */
export function startsWithSilentToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) return false;
  return getLeadingAttachedRegex(token).test(text);
}

/** Streaming partial-token detector — true when the chunk is consistent with
 *  the model being mid-emission. Uppercase-only to avoid matching `"No, ..."`;
 *  bare `"NO"` is allowed only for SILENT_REPLY_TOKEN. */
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
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}
