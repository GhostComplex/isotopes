// src/silent-reply.test.ts — Tests for silent reply token detection.

import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyEnvelopeText,
  isSilentReplyPayloadText,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "./silent-reply.js";

describe("token constants", () => {
  it("uses bare tokens (no surrounding brackets)", () => {
    expect(SILENT_REPLY_TOKEN).toBe("NO_REPLY");
    expect(HEARTBEAT_TOKEN).toBe("HEARTBEAT_OK");
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
    expect(isSilentReplyText("HEARTBEAT_OK", HEARTBEAT_TOKEN)).toBe(true);
    expect(isSilentReplyText("NO_REPLY", HEARTBEAT_TOKEN)).toBe(false);
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
    expect(isSilentReplyEnvelopeText('{"action":"HEARTBEAT_OK"}', HEARTBEAT_TOKEN)).toBe(true);
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

describe("stripSilentToken", () => {
  it("strips a trailing token", () => {
    expect(stripSilentToken("done. NO_REPLY")).toBe("done.");
  });

  it("strips a token preceded by bold asterisks (no trailing close)", () => {
    expect(stripSilentToken("done. **NO_REPLY")).toBe("done.");
  });

  it("does not strip when trailing characters block end-of-string", () => {
    // The matcher requires the token at end-of-string (modulo whitespace), so
    // closing bold asterisks after the token prevent stripping.
    expect(stripSilentToken("done. **NO_REPLY**")).toBe("done. **NO_REPLY**");
  });

  it("returns empty string when only the token is present", () => {
    expect(stripSilentToken("NO_REPLY")).toBe("");
    expect(stripSilentToken("  NO_REPLY  ")).toBe("");
  });

  it("leaves text without trailing token unchanged", () => {
    expect(stripSilentToken("normal reply")).toBe("normal reply");
  });
});

describe("stripLeadingSilentToken", () => {
  it("strips a single leading token", () => {
    expect(stripLeadingSilentToken("NO_REPLY actually here")).toBe("actually here");
  });

  it("strips multiple leading tokens", () => {
    expect(stripLeadingSilentToken("NO_REPLY NO_REPLY hi")).toBe("hi");
  });

  it("strips a token glued to following content", () => {
    expect(stripLeadingSilentToken("NO_REPLYhello")).toBe("hello");
  });

  it("returns empty string when only tokens are present", () => {
    expect(stripLeadingSilentToken("NO_REPLY NO_REPLY")).toBe("");
  });

  it("leaves text without a leading token unchanged", () => {
    expect(stripLeadingSilentToken("ordinary reply")).toBe("ordinary reply");
  });
});

describe("startsWithSilentToken", () => {
  it("matches token glued to a letter", () => {
    expect(startsWithSilentToken("NO_REPLYhello")).toBe(true);
  });

  it("matches token glued to a digit", () => {
    expect(startsWithSilentToken("NO_REPLY1")).toBe(true);
  });

  it("does not match when the token is followed by whitespace", () => {
    expect(startsWithSilentToken("NO_REPLY hello")).toBe(false);
  });

  it("does not match when the token is followed by punctuation", () => {
    expect(startsWithSilentToken("NO_REPLY: actually here")).toBe(false);
  });

  it("rejects empty / undefined input", () => {
    expect(startsWithSilentToken("")).toBe(false);
    expect(startsWithSilentToken(undefined)).toBe(false);
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches partial uppercase prefixes of NO_REPLY", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_R")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
  });

  it("rejects lowercase / mixed-case fragments", () => {
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("No_R")).toBe(false);
  });

  it("rejects single-character fragments", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
  });

  it("rejects fragments containing non-allowed characters", () => {
    expect(isSilentReplyPrefixText("NO!")).toBe(false);
    expect(isSilentReplyPrefixText("NO ")).toBe(false);
  });

  it("rejects fragments that diverge from the token", () => {
    expect(isSilentReplyPrefixText("NX")).toBe(false);
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
  });

  it("requires an underscore for arbitrary tokens (no bare 'HE' for HEARTBEAT_OK)", () => {
    expect(isSilentReplyPrefixText("HE", HEARTBEAT_TOKEN)).toBe(false);
    expect(isSilentReplyPrefixText("HEART", HEARTBEAT_TOKEN)).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", HEARTBEAT_TOKEN)).toBe(true);
    expect(isSilentReplyPrefixText("HEARTBEAT_OK", HEARTBEAT_TOKEN)).toBe(true);
  });

  it("rejects empty / undefined input", () => {
    expect(isSilentReplyPrefixText("")).toBe(false);
    expect(isSilentReplyPrefixText(undefined)).toBe(false);
  });
});
