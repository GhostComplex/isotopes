const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/** Split into Discord-sendable chunks, preferring newline / space breaks. */
export function chunkDiscordMessage(content: string, maxLength = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (content.length <= maxLength) return [content];
  const out: string[] = [];
  let remaining = content;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.5) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
