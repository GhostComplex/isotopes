import type { Message as DiscordMessage } from "discord.js";
import { createLogger } from "../../logging/logger.js";
import type { InboundImage } from "../../gateway/types.js";

const log = createLogger("discord");

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
      log.warn(`skipping oversized image attachment (${attachment.size} bytes)`);
      continue;
    }
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) {
        log.warn(`failed to fetch attachment ${attachment.url}: ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      images.push({ type: "image", data: buffer.toString("base64"), mimeType: ct });
    } catch (err) {
      log.warn(`error downloading attachment: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return images;
}
