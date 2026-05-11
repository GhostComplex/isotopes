// Detect whether agent output is a "silent reply" — i.e. nothing to deliver to
// the user. Used by heartbeat to decide log level for the agent's response.

const ESCAPE_REGEX_PATTERN = /[.*+?^${}()|[\]\\]/g;

function escapeForRegex(input: string): string {
  return input.replace(ESCAPE_REGEX_PATTERN, "\\$&");
}

export const SILENT_REPLY_TOKEN = "NO_REPLY";

const exactRegexCache = new Map<string, RegExp>();

function getExactRegex(token: string): RegExp {
  const cached = exactRegexCache.get(token);
  if (cached) return cached;
  const regex = new RegExp(`^\\s*${escapeForRegex(token)}\\s*$`, "i");
  exactRegexCache.set(token, regex);
  return regex;
}

/** Strict: trimmed text equals `token` (case-insensitive). */
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
