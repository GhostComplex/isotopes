import type { Message as DiscordMessage } from "discord.js";
import type { InboundImage } from "../../gateway/types.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024;

/** Download every accepted image attachment and return as base64 InboundImage[]. */
export async function extractAttachmentImages(msg: DiscordMessage): Promise<InboundImage[]> {
  const images: InboundImage[] = [];
  if (!msg.attachments) return images;
  for (const [, attachment] of msg.attachments) {
    const ct = attachment.contentType;
    if (!ct || !IMAGE_TYPES.has(ct)) continue;
    if (attachment.size > MAX_BYTES) {
      continue;
    }
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) {
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      images.push({ type: "image", data: buffer.toString("base64"), mimeType: ct });
    } catch { /* ignore */ }
  }
  return images;
}
