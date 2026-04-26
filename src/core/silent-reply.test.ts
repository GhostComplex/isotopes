// src/transports/silent-reply.test.ts — Tests for silent reply token detection

import { describe, it, expect } from "vitest";
import { isSilentReply, SILENT_REPLY_TOKENS } from "./silent-reply.js";

describe("isSilentReply", () => {
  // ---- Positive cases ----

  it("detects [NO_REPLY] as silent", () => {
    expect(isSilentReply("[NO_REPLY]")).toBe(true);
  });

  it("detects [HEARTBEAT_OK] as silent", () => {
    expect(isSilentReply("[HEARTBEAT_OK]")).toBe(true);
  });

  it("detects [NO_REPLY] with leading/trailing whitespace", () => {
    expect(isSilentReply("  [NO_REPLY]  ")).toBe(true);
  });

  it("detects [HEARTBEAT_OK] with newlines", () => {
    expect(isSilentReply("\n[HEARTBEAT_OK]\n")).toBe(true);
  });

  // ---- Negative cases ----

  it("rejects normal text", () => {
    expect(isSilentReply("Hello, how can I help?")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSilentReply("")).toBe(false);
  });

  it("rejects token embedded in other text", () => {
    expect(isSilentReply("Sure, [NO_REPLY] is the token")).toBe(false);
  });

  it("rejects partial token match", () => {
    expect(isSilentReply("[NO_REPLY")).toBe(false);
  });

  it("rejects case-insensitive variant (must be exact)", () => {
    expect(isSilentReply("[no_reply]")).toBe(false);
  });

  it("rejects similar-looking but different token", () => {
    expect(isSilentReply("[HEARTBEAT_FAIL]")).toBe(false);
  });
});

describe("SILENT_REPLY_TOKENS", () => {
  it("contains exactly the expected tokens", () => {
    expect(SILENT_REPLY_TOKENS).toEqual(["[NO_REPLY]", "[HEARTBEAT_OK]"]);
  });
});
