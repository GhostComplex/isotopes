import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { AgentRuntime, MAX_CONCURRENT_RUNS, DEFAULT_MAX_DEPTH } from "./runtime.js";
import { ExternalRunner, mapSdkToRunEvent } from "./runners/external.js";
import type { RunEvent, RunResult } from "./types.js";
import { collectResult } from "./helpers.js";

describe("mapSdkToRunEvent", () => {
  it("maps assistant text blocks to message events", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    } as unknown as SDKMessage;
    const events = mapSdkToRunEvent(msg);
    expect(events).toEqual([{ type: "run:message", content: "hello" }]);
  });

  it("maps assistant tool_use blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { path: "/x" } }],
      },
    } as unknown as SDKMessage;
    const events = mapSdkToRunEvent(msg);
    expect(events).toEqual([
      { type: "run:tool_use", toolName: "Read", toolInput: { path: "/x" } },
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
    const events = mapSdkToRunEvent(msg);
    expect(events).toEqual([
      { type: "run:tool_result", toolName: "abc", toolResult: "result text" },
    ]);
  });

  it("resolves tool_result toolName via shared toolNameById map", () => {
    const map = new Map<string, string>();
    const useMsg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
    } as unknown as SDKMessage;
    mapSdkToRunEvent(useMsg, map);

    const resultMsg = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "data" }] },
    } as unknown as SDKMessage;
    const events = mapSdkToRunEvent(resultMsg, map);
    expect(events).toEqual([
      { type: "run:tool_result", toolName: "Read", toolResult: "data" },
    ]);
  });

  it("skips user replay messages", () => {
    const msg = {
      type: "user",
      isReplay: true,
      message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] },
    } as unknown as SDKMessage;
    expect(mapSdkToRunEvent(msg)).toEqual([]);
  });

  it("maps success result to done", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
    } as unknown as SDKMessage;
    expect(mapSdkToRunEvent(msg)).toEqual([{ type: "run:done", exitCode: 0, costUsd: 0.01 }]);
  });

  it("maps error result to error + done(1)", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      errors: ["oops"],
      total_cost_usd: 0,
    } as unknown as SDKMessage;
    expect(mapSdkToRunEvent(msg)).toEqual([
      { type: "run:error", error: "oops" },
      { type: "run:done", exitCode: 1, costUsd: 0 },
    ]);
  });
});

describe("AgentRuntime", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    mockQuery.mockReset();
    runtime = new AgentRuntime();
  });

  it("rejects unknown runner type", async () => {
    const gen = runtime.spawn("t1", {
      runner: "bogus" as never,
      prompt: "x",
      cwd: process.cwd(),
    });
    await expect(gen.next()).rejects.toThrow(/No runner registered/);
  });

  it("streams SDK messages through mapSdkToRunEvent", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", total_cost_usd: 0 } as unknown as SDKMessage;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: RunEvent[] = [];
    for await (const ev of runtime.spawn("t2", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
    })) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: "run:start" });
    expect(events).toContainEqual({ type: "run:message", content: "hi" });
    expect(events).toContainEqual({ type: "run:done", exitCode: 0, costUsd: 0 });
  });

  it("emits error + done on SDK throw", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      throw new Error("boom");
      yield undefined as never;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: RunEvent[] = [];
    for await (const ev of runtime.spawn("t3", {
      runner: "external",
      prompt: "x",
      cwd: process.cwd(),
    })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "run:error" && e.error === "boom")).toBe(true);
    expect(events.some(e => e.type === "run:done" && e.exitCode === 1)).toBe(true);
  });

  it("collectResult aggregates events", async () => {
    async function* gen(): AsyncGenerator<RunEvent> {
      yield { type: "run:start" };
      yield { type: "run:message", content: "a" };
      yield { type: "run:message", content: "b" };
      yield { type: "run:done", exitCode: 0, costUsd: 0.02 };
    }
    const result = await collectResult(gen());
    expect(result.success).toBe(true);
    expect(result.output).toBe("a\nb");
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.02);
  });

  it("exposes MAX_CONCURRENT_RUNS", () => {
    expect(MAX_CONCURRENT_RUNS).toBe(5);
  });

  it("calls onComplete with RunResult after all events are yielded", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", total_cost_usd: 0.05 } as unknown as SDKMessage;
    }
    mockQuery.mockReturnValue(sdkStream());

    let capturedResult: RunResult | undefined;
    const events: RunEvent[] = [];
    for await (const ev of runtime.spawn("t-cb", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
      onComplete: (result) => { capturedResult = result; },
    })) {
      events.push(ev);
    }
    expect(capturedResult).toBeDefined();
    expect(capturedResult!.success).toBe(true);
    expect(capturedResult!.exitCode).toBe(0);
    expect(capturedResult!.output).toBe("done");
    expect(capturedResult!.costUsd).toBe(0.05);
  });

  it("swallows onComplete errors without breaking the run", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: "result", subtype: "success", total_cost_usd: 0 } as unknown as SDKMessage;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: RunEvent[] = [];
    for await (const ev of runtime.spawn("t-cb-err", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
      onComplete: () => { throw new Error("callback boom"); },
    })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "run:done")).toBe(true);
  });
});

describe("AgentRuntime depth limiting", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    runtime = new AgentRuntime();
  });

  it("defaults maxDepth to DEFAULT_MAX_DEPTH (1)", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(1);
  });

  it("allows spawn at depth 0 with default maxDepth", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: "result", subtype: "success", total_cost_usd: 0 } as unknown as SDKMessage;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: RunEvent[] = [];
    for await (const ev of runtime.spawn("t-d0", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
      depth: 0,
    })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "run:start")).toBe(true);
  });

  it("rejects spawn when depth >= maxDepth", async () => {
    const gen = runtime.spawn("t-deep", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
      depth: 1,
      maxDepth: 1,
    });
    await expect(gen.next()).rejects.toThrow(/Max agent nesting depth/);
  });

  it("rejects spawn when depth exceeds default maxDepth", async () => {
    const gen = runtime.spawn("t-deep2", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
      depth: 1,
    });
    await expect(gen.next()).rejects.toThrow(/Max agent nesting depth/);
  });

  it("allows deeper nesting when maxDepth is raised", async () => {
    async function* sdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: "result", subtype: "success", total_cost_usd: 0 } as unknown as SDKMessage;
    }
    mockQuery.mockReturnValue(sdkStream());

    const events: RunEvent[] = [];
    for await (const ev of runtime.spawn("t-deep3", {
      runner: "external",
      prompt: "hi",
      cwd: process.cwd(),
      depth: 2,
      maxDepth: 5,
    })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "run:start")).toBe(true);
  });
});

describe("ExternalRunner.buildSdkOptions settingSources", () => {
  it("defaults settingSources to ['user']", () => {
    const runner = new ExternalRunner({});
    const opts = runner.buildSdkOptions(
      { runner: "external", cwd: "/tmp", prompt: "hi" },
      new AbortController(),
    );
    expect(opts.settingSources).toEqual(["user"]);
    expect(opts.env).toBeUndefined();
  });

  it("forwards explicit settingSources, including empty array (opt-out)", () => {
    const runner = new ExternalRunner({ settingSources: [] });
    const opts = runner.buildSdkOptions(
      { runner: "external", cwd: "/tmp", prompt: "hi" },
      new AbortController(),
    );
    expect(opts.settingSources).toEqual([]);
  });
});

describe("AgentRuntime.validateCwd", () => {
  let tmpRoot: string;
  let allowed: string;
  let outside: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agents-sec-"));
    allowed = join(tmpRoot, "allowed");
    outside = join(tmpRoot, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("accepts cwd inside allowedRoots", () => {
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [allowed] });
    expect(() => rt.validateCwd(allowed)).not.toThrow();
    const sub = join(allowed, "nested");
    mkdirSync(sub);
    expect(() => rt.validateCwd(sub)).not.toThrow();
  });

  it("rejects cwd outside allowedRoots", () => {
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [allowed] });
    expect(() => rt.validateCwd(outside)).toThrow(/outside allowed workspaces/);
  });

  it("rejects non-existent cwd", () => {
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [allowed] });
    expect(() => rt.validateCwd(join(tmpRoot, "nope"))).toThrow(/does not exist/);
  });

  it("rejects symlink escaping allowedRoots via realpath", () => {
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [allowed] });
    const escape = join(allowed, "escape");
    symlinkSync(outside, escape);
    expect(() => rt.validateCwd(escape)).toThrow(/outside allowed workspaces/);
  });

  it("rejects cwd that is a file, not a directory", () => {
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [allowed] });
    const file = join(allowed, "file.txt");
    writeFileSync(file, "x");
    expect(() => rt.validateCwd(file)).toThrow(/not a directory/);
  });

  it("allows any dir when allowedRoots is empty", () => {
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [] });
    expect(() => rt.validateCwd(outside)).not.toThrow();
  });

  it("rejects prefix-only path matches (e.g. /allowed-evil vs /allowed)", () => {
    const evil = join(tmpRoot, "allowed-evil");
    mkdirSync(evil);
    const rt = new AgentRuntime({ allowedWorkspaceRoots: [allowed] });
    expect(() => rt.validateCwd(evil)).toThrow(/outside allowed workspaces/);
  });
});
