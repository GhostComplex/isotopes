// src/subagent/acpx-backend.test.ts — Unit tests for AcpxBackend

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AcpxBackend, parseJsonLine, collectResult, MAX_CONCURRENT_AGENTS } from "./acpx-backend.js";
import type { AcpxEvent } from "./types.js";
import { tmpdir } from "node:os";
import { mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "../core/config.js";

// ---------------------------------------------------------------------------
// parseJsonLine
// ---------------------------------------------------------------------------

describe("parseJsonLine", () => {
  it("parses a message event", () => {
    const line = JSON.stringify({ type: "message", content: "Hello world" });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "message", content: "Hello world" });
  });

  it("parses a tool_use event", () => {
    const line = JSON.stringify({ type: "tool_use", tool: "shell", input: { cmd: "ls" } });
    const event = parseJsonLine(line);
    expect(event).toEqual({
      type: "tool_use",
      toolName: "shell",
      toolInput: { cmd: "ls" },
    });
  });

  it("parses a tool_use event with name field", () => {
    const line = JSON.stringify({ type: "tool_use", name: "read_file", arguments: { path: "/tmp" } });
    const event = parseJsonLine(line);
    expect(event).toEqual({
      type: "tool_use",
      toolName: "read_file",
      toolInput: { path: "/tmp" },
    });
  });

  it("parses a tool_result event", () => {
    const line = JSON.stringify({ type: "tool_result", tool: "shell", result: "file.txt" });
    const event = parseJsonLine(line);
    expect(event).toEqual({
      type: "tool_result",
      toolName: "shell",
      toolResult: "file.txt",
    });
  });

  it("parses a tool_result event with output field", () => {
    const line = JSON.stringify({ type: "tool_result", name: "read_file", output: "content" });
    const event = parseJsonLine(line);
    expect(event).toEqual({
      type: "tool_result",
      toolName: "read_file",
      toolResult: "content",
    });
  });

  it("parses an error event", () => {
    const line = JSON.stringify({ type: "error", error: "Something went wrong" });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "error", error: "Something went wrong" });
  });

  it("parses an error event with message field", () => {
    const line = JSON.stringify({ type: "error", message: "Bad request" });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "error", error: "Bad request" });
  });

  it("parses a done event", () => {
    const line = JSON.stringify({ type: "done", exitCode: 0 });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "done", exitCode: 0 });
  });

  it("parses a done event with non-zero exit code", () => {
    const line = JSON.stringify({ type: "done", exitCode: 1 });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "done", exitCode: 1 });
  });

  it("returns undefined for empty lines", () => {
    expect(parseJsonLine("")).toBeUndefined();
    expect(parseJsonLine("  ")).toBeUndefined();
    expect(parseJsonLine("\n")).toBeUndefined();
  });

  it("returns undefined for non-JSON lines", () => {
    expect(parseJsonLine("not json")).toBeUndefined();
    expect(parseJsonLine("Starting agent...")).toBeUndefined();
  });

  it("returns undefined for JSON without type field", () => {
    const line = JSON.stringify({ data: "something" });
    expect(parseJsonLine(line)).toBeUndefined();
  });

  it("maps unknown type with content as message", () => {
    const line = JSON.stringify({ type: "thinking", content: "Hmm..." });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "message", content: "Hmm..." });
  });

  it("returns undefined for unknown type without content", () => {
    const line = JSON.stringify({ type: "heartbeat", ts: 123 });
    expect(parseJsonLine(line)).toBeUndefined();
  });

  it("handles whitespace around JSON", () => {
    const line = `  ${JSON.stringify({ type: "message", content: "hi" })}  `;
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "message", content: "hi" });
  });

  it("handles missing content in message event", () => {
    const line = JSON.stringify({ type: "message" });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "message", content: "" });
  });

  it("defaults exitCode to 0 when missing in done event", () => {
    const line = JSON.stringify({ type: "done" });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "done", exitCode: 0 });
  });

  it("defaults error to 'unknown error' when missing in error event", () => {
    const line = JSON.stringify({ type: "error" });
    const event = parseJsonLine(line);
    expect(event).toEqual({ type: "error", error: "unknown error" });
  });
});

// ---------------------------------------------------------------------------
// AcpxBackend.buildArgs
// ---------------------------------------------------------------------------

describe("AcpxBackend", () => {
  let backend: AcpxBackend;

  beforeEach(() => {
    backend = new AcpxBackend();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // validateAgent
  // ---------------------------------------------------------------------------

  describe("validateAgent", () => {
    it("accepts valid agent names", () => {
      expect(() => backend.validateAgent("claude")).not.toThrow();
      expect(() => backend.validateAgent("codex")).not.toThrow();
      expect(() => backend.validateAgent("gemini")).not.toThrow();
      expect(() => backend.validateAgent("cursor")).not.toThrow();
      expect(() => backend.validateAgent("copilot")).not.toThrow();
      expect(() => backend.validateAgent("opencode")).not.toThrow();
      expect(() => backend.validateAgent("kimi")).not.toThrow();
      expect(() => backend.validateAgent("qwen")).not.toThrow();
    });

    it("rejects unknown agent names", () => {
      expect(() => backend.validateAgent("unknown")).toThrow(/Unknown agent/);
      expect(() => backend.validateAgent("gpt4")).toThrow(/Unknown agent/);
      expect(() => backend.validateAgent("")).toThrow(/Unknown agent/);
      expect(() => backend.validateAgent("../malicious")).toThrow(/Unknown agent/);
    });
  });

  // ---------------------------------------------------------------------------
  // validateCwd
  // ---------------------------------------------------------------------------

  describe("validateCwd", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "acpx-test-"));
    });

    afterEach(() => {
      try { rmdirSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    });

    it("accepts existing directories", () => {
      expect(() => backend.validateCwd(tempDir)).not.toThrow();
    });

    it("rejects non-existent paths", () => {
      expect(() => backend.validateCwd("/nonexistent-path-12345")).toThrow(/does not exist/);
    });

    it("rejects non-directory paths", () => {
      const filePath = join(tempDir, "file.txt");
      writeFileSync(filePath, "test");
      expect(() => backend.validateCwd(filePath)).toThrow(/not a directory/);
    });

    it("validates against allowed roots when configured", () => {
      const subDir = join(tempDir, "workspace");
      const fsModule = require("node:fs") as typeof import("node:fs"); // eslint-disable-line @typescript-eslint/no-require-imports
      fsModule.mkdirSync(subDir);

      const restrictedBackend = new AcpxBackend([subDir]);

      // Path within allowed root should work
      expect(() => restrictedBackend.validateCwd(subDir)).not.toThrow();

      // Path outside allowed root should fail
      expect(() => restrictedBackend.validateCwd(tempDir)).toThrow(/outside allowed workspaces/);
    });

    it("allows any path when no roots configured", () => {
      // No roots = allow anywhere
      expect(() => backend.validateCwd(tempDir)).not.toThrow();
    });
  });

  describe("buildLegacyArgs", () => {
    it("includes print mode and stream-json output by default", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test prompt",
        cwd: "/tmp",
      });
      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
    });

    // M8: Default is now 'allowlist' mode, not 'skip' mode
    it("uses allowlist permission mode by default (M8)", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test prompt",
        cwd: "/tmp",
      });
      // Should NOT include --dangerously-skip-permissions by default
      expect(args).not.toContain("--dangerously-skip-permissions");
      // Should include --allowedTools with default list
      expect(args).toContain("--allowedTools");
    });

    // M8: Test that default allowed tools match the safe list (no Bash)
    it("includes the default allowed tool list without Bash (M8)", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test prompt",
        cwd: "/tmp",
      });

      const idx = args.indexOf("--allowedTools");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args.slice(idx + 1)).toEqual(DEFAULT_SUBAGENT_ALLOWED_TOOLS);
      // Verify Bash is not in the default list
      expect(args.slice(idx + 1)).not.toContain("Bash");
    });

    // M8: Test skip permission mode
    it("uses --dangerously-skip-permissions when permissionMode is 'skip'", () => {
      const skipBackend = new AcpxBackend({
        permissionMode: "skip",
      });
      const args = skipBackend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
      });
      expect(args).toContain("--dangerously-skip-permissions");
    });

    // M8: Test default permission mode (no flags)
    it("includes no permission flags when permissionMode is 'default'", () => {
      const defaultBackend = new AcpxBackend({
        permissionMode: "default",
      });
      const args = defaultBackend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
      });
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--allowedTools");
    });

    // M8: Test custom allowed tools
    it("uses custom allowedTools when provided", () => {
      const customBackend = new AcpxBackend({
        permissionMode: "allowlist",
        allowedTools: ["Read", "Write", "Bash"],
      });
      const args = customBackend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
      });
      const idx = args.indexOf("--allowedTools");
      expect(args.slice(idx + 1)).toContain("Bash");
    });

    // M8: Test per-spawn option override
    it("allows per-spawn permissionMode override", () => {
      // Backend defaults to 'allowlist', but spawn uses 'skip'
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
        permissionMode: "skip",
      });
      expect(args).toContain("--dangerously-skip-permissions");
    });

    it("includes --model when specified", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
        model: "claude-sonnet-4-20250514",
      });
      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe("claude-sonnet-4-20250514");
    });

    it("does not encode timeout in CLI args", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
        timeout: 300,
      });
      expect(args).not.toContain("--timeout");
      expect(args).not.toContain("300");
    });

    it("includes --max-turns when specified", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "test",
        cwd: "/tmp",
        maxTurns: 10,
      });
      const idx = args.indexOf("--max-turns");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("10");
    });

    it("does not include prompt in args because it is passed via stdin", () => {
      const args = backend.buildLegacyArgs({
        agent: "claude",
        prompt: "do something cool",
        cwd: "/tmp",
        model: "fast-model",
        timeout: 60,
      });
      expect(args).not.toContain("do something cool");
    });

    // M8: Updated to reflect new default (allowlist mode, no Bash)
    it("builds minimal args correctly with default allowlist mode (M8)", () => {
      const args = backend.buildLegacyArgs({
        agent: "codex",
        prompt: "hello",
        cwd: "/home",
      });
      expect(args).toEqual([
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--allowedTools", ...DEFAULT_SUBAGENT_ALLOWED_TOOLS,
      ]);
    });

    // M8: Updated to reflect new behavior
    it("builds full args correctly with model and maxTurns (M8)", () => {
      const args = backend.buildLegacyArgs({
        agent: "gemini",
        prompt: "write tests",
        cwd: "/project",
        model: "gemini-2.5-pro",
        timeout: 120,
        maxTurns: 5,
      });
      expect(args).toEqual([
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--allowedTools", ...DEFAULT_SUBAGENT_ALLOWED_TOOLS,
        "--model", "gemini-2.5-pro",
        "--max-turns", "5",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // workspacesKey (M8.5)
  // ---------------------------------------------------------------------------

  describe("workspacesKey", () => {
    it("generates a consistent key from allowed workspaces", () => {
      const backend1 = new AcpxBackend(["/a", "/b"]);
      const backend2 = new AcpxBackend(["/b", "/a"]); // Different order
      // Keys should be the same after sorting
      expect(backend1.workspacesKey).toBe(backend2.workspacesKey);
    });

    it("generates empty key when no workspaces", () => {
      const backend1 = new AcpxBackend();
      expect(backend1.workspacesKey).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // cancel / isRunning / activeCount
  // ---------------------------------------------------------------------------

  describe("MAX_CONCURRENT_AGENTS", () => {
    it("is exported and has a reasonable value", () => {
      expect(MAX_CONCURRENT_AGENTS).toBeGreaterThan(0);
      expect(MAX_CONCURRENT_AGENTS).toBeLessThanOrEqual(10);
    });
  });

  describe("cancel", () => {
    it("returns false for unknown taskId", () => {
      expect(backend.cancel("nonexistent")).toBe(false);
    });
  });

  describe("isRunning", () => {
    it("returns false for unknown taskId", () => {
      expect(backend.isRunning("nonexistent")).toBe(false);
    });
  });

  describe("activeCount", () => {
    it("starts at 0", () => {
      expect(backend.activeCount).toBe(0);
    });
  });

  describe("cancelAll", () => {
    it("does nothing when no processes are running", () => {
      // Should not throw
      backend.cancelAll();
      expect(backend.activeCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// collectResult
// ---------------------------------------------------------------------------

describe("collectResult", () => {
  async function* eventGen(...events: AcpxEvent[]): AsyncGenerator<AcpxEvent> {
    for (const e of events) {
      yield e;
    }
  }

  it("collects events into a result with success=true", async () => {
    const result = await collectResult(
      eventGen(
        { type: "start" },
        { type: "message", content: "Hello" },
        { type: "done", exitCode: 0 },
      ),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello");
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(3);
  });

  it("marks result as failed with non-zero exit code", async () => {
    const result = await collectResult(
      eventGen(
        { type: "start" },
        { type: "error", error: "Process crashed" },
        { type: "done", exitCode: 1 },
      ),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Process crashed");
    expect(result.exitCode).toBe(1);
  });

  it("marks result as failed when errors exist even with exitCode 0", async () => {
    const result = await collectResult(
      eventGen(
        { type: "start" },
        { type: "error", error: "warning" },
        { type: "done", exitCode: 0 },
      ),
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("concatenates multiple messages", async () => {
    const result = await collectResult(
      eventGen(
        { type: "message", content: "Line 1" },
        { type: "message", content: "Line 2" },
        { type: "done", exitCode: 0 },
      ),
    );

    expect(result.output).toBe("Line 1\nLine 2");
  });

  it("concatenates multiple errors", async () => {
    const result = await collectResult(
      eventGen(
        { type: "error", error: "Error 1" },
        { type: "error", error: "Error 2" },
        { type: "done", exitCode: 1 },
      ),
    );

    expect(result.error).toBe("Error 1\nError 2");
  });

  it("handles empty event stream", async () => {
    const result = await collectResult(eventGen());

    expect(result.success).toBe(true);
    expect(result.output).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it("skips messages with no content", async () => {
    const result = await collectResult(
      eventGen(
        { type: "message" },
        { type: "message", content: "real" },
        { type: "done", exitCode: 0 },
      ),
    );

    expect(result.output).toBe("real");
  });

  it("skips errors with no error text", async () => {
    const result = await collectResult(
      eventGen(
        { type: "error" },
        { type: "done", exitCode: 0 },
      ),
    );

    // An error event with no error text still counts as an error
    // but error field itself should be undefined since no error text
    expect(result.error).toBeUndefined();
  });

  it("includes tool events in event list but not in output", async () => {
    const result = await collectResult(
      eventGen(
        { type: "tool_use", toolName: "shell", toolInput: { cmd: "ls" } },
        { type: "tool_result", toolName: "shell", toolResult: "file.txt" },
        { type: "done", exitCode: 0 },
      ),
    );

    expect(result.output).toBeUndefined();
    expect(result.events).toHaveLength(3);
    expect(result.events[0].type).toBe("tool_use");
    expect(result.events[1].type).toBe("tool_result");
  });
});
