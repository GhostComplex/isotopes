import { Jimp } from "jimp";

const MAX_DIMENSION = 2000;

export async function resizeIfTooLarge(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (mimeType === "image/gif") return { buffer, mimeType };

  let image;
  try {
    image = await Jimp.read(buffer);
  } catch {
    return { buffer, mimeType };
  }
  const { width, height } = image.bitmap;
  if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
    return { buffer, mimeType };
  }

  if (width >= height) {
    image.resize({ w: MAX_DIMENSION });
  } else {
    image.resize({ h: MAX_DIMENSION });
  }

  const outMime = mimeType === "image/webp" ? "image/png" : mimeType;
  const out = await image.getBuffer(outMime as "image/png" | "image/jpeg");
  return { buffer: out, mimeType: outMime };
}
