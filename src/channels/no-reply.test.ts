import { describe, expect, it } from "vitest";
import { isSilentReplyPayloadText } from "./no-reply.js";

describe("isSilentReplyPayloadText", () => {
  describe("bare token form", () => {
    it("matches the bare token", () => {
      expect(isSilentReplyPayloadText("NO_REPLY")).toBe(true);
    });

    it("matches with surrounding whitespace and newlines", () => {
      expect(isSilentReplyPayloadText("  NO_REPLY  ")).toBe(true);
      expect(isSilentReplyPayloadText("\nNO_REPLY\n")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isSilentReplyPayloadText("no_reply")).toBe(true);
      expect(isSilentReplyPayloadText("No_Reply")).toBe(true);
    });

    it("rejects substantive replies that mention or end with the token", () => {
      expect(isSilentReplyPayloadText("Sure thing. NO_REPLY")).toBe(false);
      expect(isSilentReplyPayloadText("NO_REPLY is the token")).toBe(false);
    });

    it("rejects partial token text", () => {
      expect(isSilentReplyPayloadText("NO_REPL")).toBe(false);
      expect(isSilentReplyPayloadText("NO_REPLY_EXTRA")).toBe(false);
    });
  });

  describe("JSON envelope form", () => {
    it("matches a single-key action envelope", () => {
      expect(isSilentReplyPayloadText('{"action":"NO_REPLY"}')).toBe(true);
      expect(isSilentReplyPayloadText('  {"action": "NO_REPLY"}  ')).toBe(true);
    });

    it("trims whitespace inside the action value", () => {
      expect(isSilentReplyPayloadText('{"action":" NO_REPLY "}')).toBe(true);
    });

    it("rejects envelopes with extra keys", () => {
      expect(isSilentReplyPayloadText('{"action":"NO_REPLY","reason":"x"}')).toBe(false);
    });

    it("rejects wrong action value", () => {
      expect(isSilentReplyPayloadText('{"action":"reply"}')).toBe(false);
    });

    it("rejects malformed JSON", () => {
      expect(isSilentReplyPayloadText('{"action":"NO_REPLY"')).toBe(false);
    });

    it("rejects arrays and non-object JSON", () => {
      expect(isSilentReplyPayloadText('["NO_REPLY"]')).toBe(false);
    });
  });

  describe("misc", () => {
    it("rejects empty / undefined input", () => {
      expect(isSilentReplyPayloadText("")).toBe(false);
      expect(isSilentReplyPayloadText(undefined)).toBe(false);
    });

    it("rejects substantive plain text", () => {
      expect(isSilentReplyPayloadText("Hello, how can I help?")).toBe(false);
      expect(isSilentReplyPayloadText("not json at all")).toBe(false);
    });

    it("matches a custom token argument", () => {
      expect(isSilentReplyPayloadText("CUSTOM", "CUSTOM")).toBe(true);
      expect(isSilentReplyPayloadText('{"action":"CUSTOM"}', "CUSTOM")).toBe(true);
      expect(isSilentReplyPayloadText("NO_REPLY", "CUSTOM")).toBe(false);
    });
  });
});
