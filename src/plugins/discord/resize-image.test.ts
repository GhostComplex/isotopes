import { describe, it, expect } from "vitest";
import { Jimp } from "jimp";
import { resizeIfTooLarge } from "./resize-image.js";

async function makePng(w: number, h: number): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: 0xff0000ff });
  return await img.getBuffer("image/png");
}

describe("resizeIfTooLarge", () => {
  it("passes through images at or below 2000px", async () => {
    const buf = await makePng(1500, 1000);
    const out = await resizeIfTooLarge(buf, "image/png");
    expect(out.buffer).toBe(buf);
    expect(out.mimeType).toBe("image/png");
  });

  it("resizes wide images so the long edge becomes 2000px", async () => {
    const buf = await makePng(4000, 1000);
    const out = await resizeIfTooLarge(buf, "image/png");
    const img = await Jimp.read(out.buffer);
    expect(img.bitmap.width).toBe(2000);
    expect(img.bitmap.height).toBe(500);
  });

  it("resizes tall images so the long edge becomes 2000px", async () => {
    const buf = await makePng(1000, 4000);
    const out = await resizeIfTooLarge(buf, "image/png");
    const img = await Jimp.read(out.buffer);
    expect(img.bitmap.height).toBe(2000);
    expect(img.bitmap.width).toBe(500);
  });

  it("skips GIFs to preserve animation", async () => {
    const buf = await makePng(4000, 4000);
    const out = await resizeIfTooLarge(buf, "image/gif");
    expect(out.buffer).toBe(buf);
    expect(out.mimeType).toBe("image/gif");
  });

  it("converts oversized webp to png since jimp cannot encode webp", async () => {
    const buf = await makePng(4000, 1000);
    const out = await resizeIfTooLarge(buf, "image/webp");
    expect(out.mimeType).toBe("image/png");
  });
});
