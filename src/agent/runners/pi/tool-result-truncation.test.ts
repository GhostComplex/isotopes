import { describe, expect, it } from "vitest";
import {
  truncateToolResultText,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
} from "./tool-result-truncation.js";

describe("truncateToolResultText", () => {
  it("returns text unchanged when under limit", () => {
    const text = "hello world";
    expect(truncateToolResultText(text, 1000)).toBe(text);
  });

  it("truncates text exceeding limit", () => {
    const text = "a".repeat(20_000);
    const result = truncateToolResultText(text, 5_000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("truncated");
  });

  it("uses DEFAULT_MAX_TOOL_RESULT_CHARS when no maxChars given", () => {
    expect(DEFAULT_MAX_TOOL_RESULT_CHARS).toBe(16_000);
    const text = "x".repeat(20_000);
    const result = truncateToolResultText(text);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX_TOOL_RESULT_CHARS + 100);
  });

  it("preserves error content at the tail (head+tail split)", () => {
    const head = "Line 1\n".repeat(500);
    const middle = "data data data\n".repeat(500);
    const tail = "\nError: something failed\nStack trace: at foo.ts:42\n";
    const text = head + middle + tail;
    const result = truncateToolResultText(text, 5000);
    expect(result).toContain("Line 1");
    expect(result).toContain("Error: something failed");
    expect(result).toContain("middle content omitted");
  });

  it("uses head-only truncation when tail has no important content", () => {
    const text = "normal line\n".repeat(1000);
    const result = truncateToolResultText(text, 5000);
    expect(result).toContain("normal line");
    expect(result).not.toContain("middle content omitted");
    expect(result).toContain("truncated");
  });

  it("tries to break at newline boundaries", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n");
    const result = truncateToolResultText(lines, 3000);
    expect(result).toContain("truncated");
    expect(result.length).toBeLessThan(lines.length);
  });

  it("detects JSON closing structure as important tail", () => {
    const json = "{\n" + '  "items": [\n' + '    {"id": 1},\n'.repeat(500) + "  ]\n}";
    const result = truncateToolResultText(json, 5000);
    expect(result).toContain("middle content omitted");
    expect(result).toContain("}");
  });

  it("detects traceback as important tail", () => {
    const output = "output line\n".repeat(500) + "\nTraceback (most recent call last):\n  File 'x.py'\n";
    const result = truncateToolResultText(output, 5000);
    expect(result).toContain("middle content omitted");
    expect(result).toContain("Traceback");
  });

  it("includes char count in truncation suffix", () => {
    const text = "x".repeat(10_000);
    const result = truncateToolResultText(text, 3000);
    expect(result).toMatch(/\d+ more characters truncated/);
  });
});
