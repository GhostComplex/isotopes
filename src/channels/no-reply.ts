// Detect whether agent output is a "silent reply" — i.e. nothing to deliver to
// the user. Used by heartbeat to decide log level for the agent's response.

const ESCAPE_REGEX_PATTERN = /[.*+?^${}()|[\]\\]/g;

function escapeForRegex(input: string): string {
  return input.replace(ESCAPE_REGEX_PATTERN, "\\$&");
}

const SILENT_REPLY_TOKEN = "NO_REPLY";

const exactRegexCache = new Map<string, RegExp>();

function getExactRegex(token: string): RegExp {
  const cached = exactRegexCache.get(token);
  if (cached) return cached;
  const regex = new RegExp(`^\\s*${escapeForRegex(token)}\\s*$`, "i");
  exactRegexCache.set(token, regex);
  return regex;
}

function isExactToken(text: string | undefined, token: string): boolean {
  if (!text) return false;
  return getExactRegex(token).test(text);
}

type SilentReplyEnvelope = { action?: unknown };

function isEnvelope(text: string | undefined, token: string): boolean {
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
 * True when the text is the agent's way of saying "no reply" — either the
 * bare token (case-insensitive, possibly with whitespace) or a single-key
 * `{"action": "NO_REPLY"}` JSON envelope.
 */
export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return isExactToken(text, token) || isEnvelope(text, token);
}
