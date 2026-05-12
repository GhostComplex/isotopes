import { describe, it, expect } from "vitest";
import { parseGroupAllowlist, isValidDiscordUserId } from "./validators.js";

describe("parseGroupAllowlist", () => {
  it("treats empty input as ok with no entries (caller decides whether to accept)", () => {
    expect(parseGroupAllowlist("")).toEqual({ ok: true, entries: [] });
    expect(parseGroupAllowlist("   ")).toEqual({ ok: true, entries: [] });
    expect(parseGroupAllowlist(" , ,")).toEqual({ ok: true, entries: [] });
  });

  it("accepts whole-guild entries", () => {
    expect(parseGroupAllowlist("111, 222")).toEqual({
      ok: true,
      entries: ["111", "222"],
    });
  });

  it("accepts channel-mode entries", () => {
    expect(parseGroupAllowlist("111/777, 111/888")).toEqual({
      ok: true,
      entries: ["111/777", "111/888"],
    });
  });

  it("trims surrounding whitespace per entry", () => {
    expect(parseGroupAllowlist("  111  ,  222  ")).toEqual({
      ok: true,
      entries: ["111", "222"],
    });
  });

  it("rejects non-numeric entries", () => {
    expect(parseGroupAllowlist("abc")).toEqual({ ok: false, reason: "format" });
    expect(parseGroupAllowlist("111, abc")).toEqual({ ok: false, reason: "format" });
    expect(parseGroupAllowlist("111/abc")).toEqual({ ok: false, reason: "format" });
  });

  it("rejects mixing whole-guild and channel entries", () => {
    expect(parseGroupAllowlist("111, 222/333")).toEqual({ ok: false, reason: "mixed" });
    expect(parseGroupAllowlist("111/333, 222")).toEqual({ ok: false, reason: "mixed" });
  });

  it("accepts a single entry of either mode", () => {
    expect(parseGroupAllowlist("111")).toEqual({ ok: true, entries: ["111"] });
    expect(parseGroupAllowlist("111/222")).toEqual({ ok: true, entries: ["111/222"] });
  });
});

describe("isValidDiscordUserId", () => {
  it("accepts numeric strings", () => {
    expect(isValidDiscordUserId("123456789012345678")).toBe(true);
    expect(isValidDiscordUserId("  111  ")).toBe(true);
  });

  it("rejects non-numeric and empty", () => {
    expect(isValidDiscordUserId("")).toBe(false);
    expect(isValidDiscordUserId("abc")).toBe(false);
    expect(isValidDiscordUserId("123abc")).toBe(false);
    expect(isValidDiscordUserId("123/456")).toBe(false);
  });
});
