// Returns the parsed entries (possibly empty), or null if the input is invalid.
// Mixed mode is rejected — see render.ts for the AND-allowlist contract.
export function parseGroupAllowlist(raw: string): string[] | null {
  const entries = raw.trim().split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return [];
  if (!entries.every((e) => /^\d+(\/\d+)?$/.test(e))) return null;
  const allWhole = entries.every((e) => !e.includes("/"));
  const allChannel = entries.every((e) => e.includes("/"));
  if (!allWhole && !allChannel) return null;
  return entries;
}

export function isValidDiscordUserId(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}
