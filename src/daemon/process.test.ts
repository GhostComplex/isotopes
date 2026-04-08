// src/daemon/process.test.ts — Unit tests for DaemonProcess

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { DaemonProcess } from "./process.js";
import type { DaemonOptions } from "./process.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    open: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockFs = fs as unknown as {
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
};

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultOpts: DaemonOptions = {
  configPath: "/home/user/.isotopes/isotopes.yaml",
  logDir: "/home/user/.isotopes/logs",
  pidFile: "/home/user/.isotopes/isotopes.pid",
};

function makeDaemon(opts?: Partial<DaemonOptions>): DaemonProcess {
  return new DaemonProcess({ ...defaultOpts, ...opts });
}

/** Stub process.kill to control "is alive" checks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let killSpy: any;

function mockProcessAlive(alive: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: any, signal: any) => {
    if (signal === 0 || signal === undefined) {
      if (!alive) throw new Error("ESRCH");
      return true;
    }
    // SIGTERM / SIGKILL – just succeed
    return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: readFile rejects (no pidfile)
  mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
});

afterEach(() => {
  killSpy?.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaemonProcess.isRunning", () => {
  it("returns false when pidfile is missing", async () => {
    const d = makeDaemon();
    expect(await d.isRunning()).toBe(false);
  });

  it("returns false when pidfile contains invalid data", async () => {
    mockFs.readFile.mockResolvedValue("not-a-number\n");
    const d = makeDaemon();
    expect(await d.isRunning()).toBe(false);
  });

  it("returns false when pid exists but process is dead", async () => {
    mockFs.readFile.mockResolvedValue("12345\n");
    mockProcessAlive(false);

    const d = makeDaemon();
    expect(await d.isRunning()).toBe(false);
  });

  it("returns true when pid exists and process is alive", async () => {
    mockFs.readFile.mockResolvedValue("12345\n");
    mockProcessAlive(true);

    const d = makeDaemon();
    expect(await d.isRunning()).toBe(true);
  });
});

describe("DaemonProcess.start", () => {
  it("spawns a detached child and writes pidfile", async () => {
    const fakeChild = {
      pid: 99999,
      unref: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeChild);

    const fakeFd = { fd: 3, close: vi.fn().mockResolvedValue(undefined) };
    mockFs.open.mockResolvedValue(fakeFd);

    const d = makeDaemon();
    const result = await d.start();

    expect(result.pid).toBe(99999);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.argv[0],
      expect.arrayContaining([expect.stringContaining("cli.js")]),
      expect.objectContaining({ detached: true }),
    );
    expect(fakeChild.unref).toHaveBeenCalled();

    // PID written
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      defaultOpts.pidFile,
      "99999",
      "utf-8",
    );

    // Start timestamp written
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      defaultOpts.pidFile + ".started",
      expect.any(String),
      "utf-8",
    );

    // File descriptors closed
    expect(fakeFd.close).toHaveBeenCalledTimes(2);
  });

  it("throws when daemon is already running", async () => {
    mockFs.readFile.mockResolvedValue("12345\n");
    mockProcessAlive(true);

    const d = makeDaemon();
    await expect(d.start()).rejects.toThrow("already running");
  });

  it("throws when spawn returns no PID", async () => {
    const fakeChild = { pid: undefined, unref: vi.fn() };
    mockSpawn.mockReturnValue(fakeChild);
    const fakeFd = { fd: 3, close: vi.fn().mockResolvedValue(undefined) };
    mockFs.open.mockResolvedValue(fakeFd);

    const d = makeDaemon();
    await expect(d.start()).rejects.toThrow("no PID");
  });
});

describe("DaemonProcess.stop", () => {
  it("sends SIGTERM and removes pidfile", async () => {
    mockFs.readFile.mockImplementation(async (p: string) => {
      if (p === defaultOpts.pidFile) return "12345\n";
      if (p === defaultOpts.pidFile + ".started")
        return new Date().toISOString();
      throw new Error("ENOENT");
    });

    // Process is alive at first, then dies after SIGTERM
    let alive = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: any, signal: any) => {
      if (signal === 0 || signal === undefined) {
        if (!alive) throw new Error("ESRCH");
        return true;
      }
      if (signal === "SIGTERM") {
        alive = false;
        return true;
      }
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const d = makeDaemon();
    await d.stop();

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    // pidfile removed
    expect(mockFs.unlink).toHaveBeenCalledWith(defaultOpts.pidFile);
  });

  it("throws when daemon is not running", async () => {
    // pidfile missing → ENOENT
    const d = makeDaemon();
    await expect(d.stop()).rejects.toThrow("not running");
  });
});

describe("DaemonProcess.status", () => {
  it("returns running=false when no pidfile", async () => {
    const d = makeDaemon();
    const s = await d.status();
    expect(s.running).toBe(false);
    expect(s.pid).toBeUndefined();
  });

  it("returns full status when daemon is running", async () => {
    const startTime = new Date(Date.now() - 120_000); // 2 min ago
    mockFs.readFile.mockImplementation(async (p: string) => {
      if (p === defaultOpts.pidFile) return "12345\n";
      if (p === defaultOpts.pidFile + ".started")
        return startTime.toISOString();
      throw new Error("ENOENT");
    });
    mockProcessAlive(true);

    const d = makeDaemon();
    const s = await d.status();

    expect(s.running).toBe(true);
    expect(s.pid).toBe(12345);
    expect(s.uptime).toBeGreaterThanOrEqual(119); // ~120s
    expect(s.startedAt).toEqual(startTime);
    expect(s.configPath).toBe(defaultOpts.configPath);
  });

  it("cleans up stale pidfile when process is dead", async () => {
    mockFs.readFile.mockImplementation(async (p: string) => {
      if (p === defaultOpts.pidFile) return "12345\n";
      throw new Error("ENOENT");
    });
    mockProcessAlive(false);

    const d = makeDaemon();
    const s = await d.status();

    expect(s.running).toBe(false);
    expect(mockFs.unlink).toHaveBeenCalledWith(defaultOpts.pidFile);
  });
});

describe("DaemonProcess.restart", () => {
  it("stops and starts the daemon", async () => {
    const fakeChild = { pid: 55555, unref: vi.fn() };
    mockSpawn.mockReturnValue(fakeChild);
    const fakeFd = { fd: 3, close: vi.fn().mockResolvedValue(undefined) };
    mockFs.open.mockResolvedValue(fakeFd);

    // No existing process running (stop will throw, restart catches it)
    const d = makeDaemon();
    const result = await d.restart();

    expect(result.pid).toBe(55555);
  });
});
