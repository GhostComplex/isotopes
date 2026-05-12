export type GroupAllowlistResult =
  | { ok: true; entries: string[] }
  | { ok: false; reason: "empty" | "format" | "mixed" };

// Mixed mode is rejected — see render.ts for the AND-allowlist contract.
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

export function isValidDiscordUserId(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}
