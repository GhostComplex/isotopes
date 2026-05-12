// Extracted from wizard.tsx so the validation logic can be unit-tested
// without bringing up Ink.

export type GroupAllowlistResult =
  | { ok: true; entries: string[] }
  | { ok: false; reason: "empty" | "format" | "mixed" };

// Mixing whole-guild and channel-mode entries is rejected because they map to
// mutually exclusive downstream lists under AND-allowlist semantics — emitting
// both would over-restrict (see render.ts).
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

// Discord snowflake = decimal digits only (length/range not validated).
export function isValidDiscordUserId(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}
