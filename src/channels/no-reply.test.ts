import { describe, expect, it } from "vitest";
import {
  isSilentReplyEnvelopeText,
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "./no-reply.js";

describe("SILENT_REPLY_TOKEN", () => {
  it("is the bare NO_REPLY string", () => {
    expect(SILENT_REPLY_TOKEN).toBe("NO_REPLY");
  });
});

describe("isSilentReplyText", () => {
  it("matches the bare token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("matches with surrounding whitespace and newlines", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSilentReplyText("no_reply")).toBe(true);
    expect(isSilentReplyText("No_Reply")).toBe(true);
  });

  it("matches a custom token argument", () => {
    expect(isSilentReplyText("CUSTOM", "CUSTOM")).toBe(true);
    expect(isSilentReplyText("NO_REPLY", "CUSTOM")).toBe(false);
  });

  it("rejects empty / undefined input", () => {
    expect(isSilentReplyText("")).toBe(false);
    expect(isSilentReplyText(undefined)).toBe(false);
  });

  it("rejects substantive replies that mention or end with the token", () => {
    expect(isSilentReplyText("Hello, how can I help?")).toBe(false);
    expect(isSilentReplyText("Sure thing. NO_REPLY")).toBe(false);
    expect(isSilentReplyText("NO_REPLY is the token")).toBe(false);
  });

  it("rejects partial token text", () => {
    expect(isSilentReplyText("NO_REPL")).toBe(false);
    expect(isSilentReplyText("NO_REPLY_EXTRA")).toBe(false);
  });
});

describe("isSilentReplyEnvelopeText", () => {
  it("matches a single-key action envelope", () => {
    expect(isSilentReplyEnvelopeText('{"action":"NO_REPLY"}')).toBe(true);
    expect(isSilentReplyEnvelopeText('  {"action": "NO_REPLY"}  ')).toBe(true);
  });

  it("trims internal whitespace inside the action value", () => {
    expect(isSilentReplyEnvelopeText('{"action":" NO_REPLY "}')).toBe(true);
  });

  it("matches a custom token argument", () => {
    expect(isSilentReplyEnvelopeText('{"action":"CUSTOM"}', "CUSTOM")).toBe(true);
  });

  it("rejects envelopes with extra keys", () => {
    expect(isSilentReplyEnvelopeText('{"action":"NO_REPLY","reason":"x"}')).toBe(false);
  });

  it("rejects wrong action value", () => {
    expect(isSilentReplyEnvelopeText('{"action":"reply"}')).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(isSilentReplyEnvelopeText('{"action":"NO_REPLY"')).toBe(false);
    expect(isSilentReplyEnvelopeText("not json at all")).toBe(false);
  });

  it("rejects arrays and non-objects", () => {
    expect(isSilentReplyEnvelopeText('["NO_REPLY"]')).toBe(false);
  });

  it("rejects empty / undefined input", () => {
    expect(isSilentReplyEnvelopeText("")).toBe(false);
    expect(isSilentReplyEnvelopeText(undefined)).toBe(false);
  });
});

describe("isSilentReplyPayloadText", () => {
  it("matches both bare and envelope forms", () => {
    expect(isSilentReplyPayloadText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPayloadText('{"action":"NO_REPLY"}')).toBe(true);
  });

  it("rejects substantive replies", () => {
    expect(isSilentReplyPayloadText("here is the answer")).toBe(false);
  });
});
