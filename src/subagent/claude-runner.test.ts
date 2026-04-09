// src/subagent/claude-runner.test.ts — Unit tests for ClaudeRunner
// Mocks child_process.spawn to test subprocess lifecycle management.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

/** Fake stdout/stderr readable stream. */
function createFakeStream() {
  return new EventEmitter();
}

/** Fake ChildProcess for testing. */
function createFakeChild(): ChildProcess & { _emit: (event: string, ...args: unknown[]) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & { _emit: (event: string, ...args: unknown[]) => void };
  const stdout = createFakeStream();
  const stderr = createFakeStream();
  Object.defineProperty(child, "stdout", { value: stdout, writable: true });
  Object.defineProperty(child, "stderr", { value: stderr, writable: true });
  Object.defineProperty(child, "pid", { value: 12345, writable: true });
  Object.defineProperty(child, "killed", { value: false, writable: true });
  Object.defineProperty(child, "stdin", { value: null, writable: true });
  Object.defineProperty(child, "stdio", { value: [null, stdout, stderr, null, null], writable: true });
  child.kill = vi.fn(() => {
    Object.defineProperty(child, "killed", { value: true, writable: true });
    return true;
  });
  child._emit = (event: string, ...args: unknown[]) => (child as unknown as EventEmitter).emit(event, ...args);
  return child;
}

let fakeChild: ReturnType<typeof createFakeChild>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => fakeChild),
}));

// Suppress log output in tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "debug").mockImplementation(() => {});

// Import after mock setup
const { ClaudeRunner } = await import("./claude-runner.js");
const { spawn } = await import("node:child_process");

describe("ClaudeRunner", () => {
  beforeEach(() => {
    fakeChild = createFakeChild();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns claude CLI with correct arguments", async () => {
    const runner = new ClaudeRunner({ cliPath: "/usr/bin/claude" });

    const runPromise = runner.run({
      id: "task-1",
      prompt: "Hello",
      workdir: "/tmp",
    });

    // Simulate immediate exit
    fakeChild._emit("close", 0, null);
    await runPromise;

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/claude",
      [
        "--print",
        "--output-format=stream-json",
        "--permission-mode=bypassPermissions",
        "-p",
        "Hello",
      ],
      expect.objectContaining({
        cwd: "/tmp",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("collects streaming events and returns result on success", async () => {
    const runner = new ClaudeRunner();
    const onEvent = vi.fn();

    const runPromise = runner.run({
      id: "task-2",
      prompt: "test",
      workdir: "/tmp",
      onEvent,
    });

    // Simulate streaming output
    fakeChild.stdout!.emit("data", Buffer.from('{"type":"assistant","content":"Hello "}\n'));
    fakeChild.stdout!.emit("data", Buffer.from('{"type":"assistant","content":"world!"}\n'));
    fakeChild.stdout!.emit("data", Buffer.from('{"type":"result"}\n'));
    fakeChild._emit("close", 0, null);

    const result = await runPromise;

    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello world!");
    expect(result.events).toHaveLength(3);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("reports failure on non-zero exit code", async () => {
    const runner = new ClaudeRunner();

    const runPromise = runner.run({
      id: "task-3",
      prompt: "test",
      workdir: "/tmp",
    });

    fakeChild.stderr!.emit("data", Buffer.from("Something went wrong"));
    fakeChild._emit("close", 1, null);

    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong");
  });

  it("reports failure on spawn error (ENOENT)", async () => {
    const runner = new ClaudeRunner({ cliPath: "/nonexistent/claude" });

    const runPromise = runner.run({
      id: "task-4",
      prompt: "test",
      workdir: "/tmp",
    });

    fakeChild._emit("error", new Error("spawn /nonexistent/claude ENOENT"));

    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to spawn Claude CLI");
    expect(result.error).toContain("ENOENT");
  });

  it("handles timeout and kills the process", async () => {
    vi.useFakeTimers();
    const runner = new ClaudeRunner();

    const runPromise = runner.run({
      id: "task-5",
      prompt: "test",
      workdir: "/tmp",
      timeout: 1000,
    });

    // Advance past timeout
    vi.advanceTimersByTime(1001);

    // Process killed, emits close
    fakeChild._emit("close", null, "SIGTERM");

    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    vi.useRealTimers();
  });

  it("cancel() kills a running task", async () => {
    const runner = new ClaudeRunner();

    const runPromise = runner.run({
      id: "task-6",
      prompt: "test",
      workdir: "/tmp",
    });

    expect(runner.isRunning("task-6")).toBe(true);

    const cancelled = runner.cancel("task-6");
    expect(cancelled).toBe(true);
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    // Process exits after cancel
    fakeChild._emit("close", null, "SIGTERM");
    await runPromise;

    expect(runner.isRunning("task-6")).toBe(false);
  });

  it("cancel() returns false for unknown task", () => {
    const runner = new ClaudeRunner();
    expect(runner.cancel("nonexistent")).toBe(false);
  });

  it("isRunning() returns false before and after task", async () => {
    const runner = new ClaudeRunner();

    expect(runner.isRunning("task-7")).toBe(false);

    const runPromise = runner.run({
      id: "task-7",
      prompt: "test",
      workdir: "/tmp",
    });

    expect(runner.isRunning("task-7")).toBe(true);

    fakeChild._emit("close", 0, null);
    await runPromise;

    expect(runner.isRunning("task-7")).toBe(false);
  });

  it("uses custom permission mode", async () => {
    const runner = new ClaudeRunner({ permissionMode: "default" });

    const runPromise = runner.run({
      id: "task-8",
      prompt: "test",
      workdir: "/tmp",
    });

    fakeChild._emit("close", 0, null);
    await runPromise;

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--permission-mode=default"]),
      expect.anything(),
    );
  });

  it("flushes remaining buffered data on close", async () => {
    const runner = new ClaudeRunner();
    const onEvent = vi.fn();

    const runPromise = runner.run({
      id: "task-9",
      prompt: "test",
      workdir: "/tmp",
      onEvent,
    });

    // Send data without trailing newline — will be buffered
    fakeChild.stdout!.emit("data", Buffer.from('{"type":"assistant","content":"buffered"}'));
    fakeChild._emit("close", 0, null);

    const result = await runPromise;

    expect(result.events).toHaveLength(1);
    expect(result.output).toBe("buffered");
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
