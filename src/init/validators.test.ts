import { describe, it, expect } from "vitest";
import { parseGroupAllowlist, isValidDiscordUserId } from "./validators.js";

describe("parseGroupAllowlist", () => {
  it("returns [] for empty input (caller decides whether to accept)", () => {
    expect(parseGroupAllowlist("")).toEqual([]);
    expect(parseGroupAllowlist("   ")).toEqual([]);
    expect(parseGroupAllowlist(" , ,")).toEqual([]);
  });

  it("accepts whole-guild entries", () => {
    expect(parseGroupAllowlist("111, 222")).toEqual(["111", "222"]);
  });

  it("accepts channel-mode entries", () => {
    expect(parseGroupAllowlist("111/777, 111/888")).toEqual(["111/777", "111/888"]);
  });

  it("trims surrounding whitespace per entry", () => {
    expect(parseGroupAllowlist("  111  ,  222  ")).toEqual(["111", "222"]);
  });

  it("returns null for non-numeric entries", () => {
    expect(parseGroupAllowlist("abc")).toBeNull();
    expect(parseGroupAllowlist("111, abc")).toBeNull();
    expect(parseGroupAllowlist("111/abc")).toBeNull();
  });

  it("returns null when whole-guild and channel entries are mixed", () => {
    expect(parseGroupAllowlist("111, 222/333")).toBeNull();
    expect(parseGroupAllowlist("111/333, 222")).toBeNull();
  });

  it("accepts a single entry of either mode", () => {
    expect(parseGroupAllowlist("111")).toEqual(["111"]);
    expect(parseGroupAllowlist("111/222")).toEqual(["111/222"]);
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
