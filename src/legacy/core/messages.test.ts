import { describe, it, expect } from "vitest";
import { userMessage, userMessageWithImages, messageText } from "./messages.js";

describe("userMessageWithImages", () => {
  const images = [
    { type: "image" as const, data: "base64data", mimeType: "image/png" },
  ];

  it("produces content array with text and image blocks", () => {
    const msg = userMessageWithImages("hello", images, 1000);
    const m = msg as unknown as { role: string; content: unknown[]; timestamp: number };

    expect(m.role).toBe("user");
    expect(m.timestamp).toBe(1000);
    expect(m.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
  });

  it("includes multiple images", () => {
    const twoImages = [
      { type: "image" as const, data: "img1", mimeType: "image/png" },
      { type: "image" as const, data: "img2", mimeType: "image/jpeg" },
    ];
    const msg = userMessageWithImages("text", twoImages);
    const m = msg as unknown as { content: unknown[] };

    expect(m.content).toHaveLength(3);
  });

  it("messageText extracts text from multimodal message", () => {
    const msg = userMessageWithImages("extracted", images);
    expect(messageText(msg)).toBe("extracted");
  });

  it("messageText works on plain text user message", () => {
    const msg = userMessage("plain");
    expect(messageText(msg)).toBe("plain");
  });
});
