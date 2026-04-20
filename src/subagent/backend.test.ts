// src/subagent/backend.test.ts — Unit tests for SubagentBackend and mapSdkMessage
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Mock the SDK query() before importing backend
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { SubagentBackend, mapSdkMessage, collectResult, MAX_CONCURRENT_AGENTS } from "./backend.js";
import { ClaudeRunner } from "./runners/claude.js";
import type { SubagentEvent } from "./types.js";

describe("mapSdkMessage", () => {
  it("maps assistant text blocks to message events", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    } as unknown as SDKMessage;
    const events = mapSdkMessage(msg);
    expect(events).toEqual([{ type: "message", content: "hello" }]);
  });

  it("maps assistant tool_use blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { path: "/x" } }],
      },
    } as unknown as SDKMessage;
    const events = mapSdkMessage(msg);
    expect(events).toEqual([
      { type: "tool_use", toolName: "Read", toolInput: { path: "/x" } },
    ]);
  });

  it("maps user tool_result blocks", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "abc", content: "result text" },
        ],
      },
    } as unknown as SDKMessage;
    const events = mapSdkMessage(msg);
    expect(events).toEqual([
      { type: "tool_result", toolName: "abc", toolResult: "result text" },
    ]);
  });

  it("resolves tool_result toolName via shared toolNameById map", () => {
    const map = new Map<string, string>();
    const useMsg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
    } as unknown as SDKMessage;
    mapSdkMessage(useMsg, map);

    const resultMsg = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "data" }] },
    } as unknown as SDKMessage;
    const events = mapSdkMessage(resultMsg, map);
    expect(events).toEqual([
      { type: "tool_result", toolName: "Read", toolResult: "data" },
    ]);
  });

  it("skips user replay messages", () => {
    const msg = {
      type: "user",
      isReplay: true,
      message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] },
    } as unknown as SDKMessage;
    expect(mapSdkMessage(msg)).toEqual([]);
  });

  it("maps success result to done", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
    } as unknown as SDKMessage;
    expect(mapSdkMessage(msg)).toEqual([{ type: "done", exitCode: 0, costUsd: 0.01 }]);
  });

  it("maps error result to error + done(1)", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      errors: ["oops"],
      total_cost_usd: 0,
    } as unknown as SDKMessage;
    expect(mapSdkMessage(msg)).toEqual([
      { type: "error", error: "oops" },
      { type: "done", exitCode: 1, costUsd: 0 },
    ]);
  });
});

describe("SubagentBackend", () => {
  let backend: SubagentBackend;

  beforeEach(() => {
    mockQuery.mockReset();
    backend = new SubagentBackend();
  });

  it("rejects unknown agent", async () => {
    const gen = backend.spawn("t1", {
      agent: "bogus" as never,
      prompt: "x",
      cwd: process.cwd(),
    });
    await expect(gen.next()).rejects.toThrow(/Unknown agent/);
  });

  it("streams SDK messages through mapSdkMessage", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", total_cost_usd: 0 } as unknown as SDKMessage;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: SubagentEvent[] = [];
    for await (const ev of backend.spawn("t2", {
      agent: "claude",
      prompt: "hi",
      cwd: process.cwd(),
    })) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: "start" });
    expect(events).toContainEqual({ type: "message", content: "hi" });
    expect(events).toContainEqual({ type: "done", exitCode: 0, costUsd: 0 });
  });

  it("emits error + done on SDK throw", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      throw new Error("boom");
      yield undefined as never;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: SubagentEvent[] = [];
    for await (const ev of backend.spawn("t3", {
      agent: "claude",
      prompt: "x",
      cwd: process.cwd(),
    })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "error" && e.error === "boom")).toBe(true);
    expect(events.some(e => e.type === "done" && e.exitCode === 1)).toBe(true);
  });

  it("collectResult aggregates events", async () => {
    async function* gen(): AsyncGenerator<SubagentEvent> {
      yield { type: "start" };
      yield { type: "message", content: "a" };
      yield { type: "message", content: "b" };
      yield { type: "done", exitCode: 0, costUsd: 0.02 };
    }
    const result = await collectResult(gen());
    expect(result.success).toBe(true);
    expect(result.output).toBe("a\nb");
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.02);
  });

  it("exposes MAX_CONCURRENT_AGENTS", () => {
    expect(MAX_CONCURRENT_AGENTS).toBe(5);
  });
});

describe("ClaudeRunner.buildSdkOptions claude env", () => {
  it("does not set env when no claude config given", () => {
    const runner = new ClaudeRunner({});
    const opts = runner.buildSdkOptions(
      { agent: "claude", cwd: "/tmp", prompt: "hi" },
      new AbortController(),
    );
    expect(opts.env).toBeUndefined();
    expect(opts.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("injects ANTHROPIC_AUTH_TOKEN/BASE_URL via Options.env without mutating process.env", () => {
    const before = process.env.ANTHROPIC_AUTH_TOKEN;
    const runner = new ClaudeRunner({
      claude: { authToken: "sk-test-123", baseUrl: "https://proxy.example/v1" },
    });
    const opts = runner.buildSdkOptions(
      { agent: "claude", cwd: "/tmp", prompt: "hi" },
      new AbortController(),
    );
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-123");
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://proxy.example/v1");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(before);
  });

  it("forwards pathToClaudeCodeExecutable", () => {
    const runner = new ClaudeRunner({
      claude: { pathToClaudeCodeExecutable: "/custom/claude" },
    });
    const opts = runner.buildSdkOptions(
      { agent: "claude", cwd: "/tmp", prompt: "hi" },
      new AbortController(),
    );
    expect(opts.pathToClaudeCodeExecutable).toBe("/custom/claude");
  });
});

describe("SubagentBackend.validateCwd", () => {
  let tmpRoot: string;
  let allowed: string;
  let outside: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "subagent-sec-"));
    allowed = join(tmpRoot, "allowed");
    outside = join(tmpRoot, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("accepts cwd inside allowedRoots", () => {
    const backend = new SubagentBackend([allowed]);
    expect(() => backend.validateCwd(allowed)).not.toThrow();
    const sub = join(allowed, "nested");
    mkdirSync(sub);
    expect(() => backend.validateCwd(sub)).not.toThrow();
  });

  it("rejects cwd outside allowedRoots", () => {
    const backend = new SubagentBackend([allowed]);
    expect(() => backend.validateCwd(outside)).toThrow(/outside allowed workspaces/);
  });

  it("rejects non-existent cwd", () => {
    const backend = new SubagentBackend([allowed]);
    expect(() => backend.validateCwd(join(tmpRoot, "nope"))).toThrow(/does not exist/);
  });

  it("rejects symlink escaping allowedRoots via realpath", () => {
    const backend = new SubagentBackend([allowed]);
    const escape = join(allowed, "escape");
    symlinkSync(outside, escape);
    expect(() => backend.validateCwd(escape)).toThrow(/outside allowed workspaces/);
  });

  it("rejects cwd that is a file, not a directory", () => {
    const backend = new SubagentBackend([allowed]);
    const file = join(allowed, "file.txt");
    writeFileSync(file, "x");
    expect(() => backend.validateCwd(file)).toThrow(/not a directory/);
  });

  it("allows any dir when allowedRoots is empty", () => {
    const backend = new SubagentBackend([]);
    expect(() => backend.validateCwd(outside)).not.toThrow();
  });

  it("rejects prefix-only path matches (e.g. /allowed-evil vs /allowed)", () => {
    const evil = join(tmpRoot, "allowed-evil");
    mkdirSync(evil);
    const backend = new SubagentBackend([allowed]);
    expect(() => backend.validateCwd(evil)).toThrow(/outside allowed workspaces/);
  });
});
