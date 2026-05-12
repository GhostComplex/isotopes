// Pure validators used by the init wizard. Extracted out of wizard.tsx so they
// can be unit-tested without bringing up Ink.

export type GroupAllowlistResult =
  | { ok: true; entries: string[] }
  | { ok: false; reason: "empty" | "format" | "mixed" };

/**
 * Parse the comma-separated server/channel allowlist input.
 *
 * Accepts either:
 *   - all "guildId" entries (whole-guild mode), or
 *   - all "guildId/channelId" entries (channel mode).
 *
 * Mixing the two is rejected because they map to mutually exclusive
 * downstream lists under AND-allowlist semantics (see render.ts).
 */
export function parseGroupAllowlist(raw: string): GroupAllowlistResult {
  const entries = raw.trim().split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return { ok: false, reason: "empty" };
  if (!entries.every((e) => /^\d+(\/\d+)?$/.test(e))) {
    return { ok: false, reason: "format" };
  }
  const allWhole = entries.every((e) => !e.includes("/"));
  const allChannel = entries.every((e) => e.includes("/"));
  if (!allWhole && !allChannel) return { ok: false, reason: "mixed" };
  return { ok: true, entries };
}

/** Discord snowflake = decimal digits only (we don't validate length/range). */
export function isValidDiscordUserId(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}
