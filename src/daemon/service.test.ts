// src/daemon/service.test.ts — Unit tests for ServiceManager

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import { exec } from "node:child_process";
import { ServiceManager, getPlatform } from "./service.js";
import type { ServiceConfig } from "./service.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  default: {
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    access: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

const mockFs = fs as unknown as {
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
};

const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleConfig: ServiceConfig = {
  name: "ai.isotopes.daemon",
  description: "Isotopes AI Agent Daemon",
  execPath: "/usr/local/bin/node",
  cliPath: "/usr/local/lib/isotopes/dist/cli.js",
  configPath: "/home/user/.isotopes/isotopes.yaml",
  logPath: "/home/user/.isotopes/logs/isotopes.out.log",
};

let platformSpy: ReturnType<typeof vi.spyOn>;

function mockPlatform(p: NodeJS.Platform) {
  platformSpy = vi.spyOn(os, "platform").mockReturnValue(p);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
  platformSpy?.mockRestore();
});

// ---------------------------------------------------------------------------
// getPlatform
// ---------------------------------------------------------------------------

describe("getPlatform", () => {
  it("returns 'macos' on darwin", () => {
    mockPlatform("darwin");
    expect(getPlatform()).toBe("macos");
  });

  it("returns 'linux' on linux", () => {
    mockPlatform("linux");
    expect(getPlatform()).toBe("linux");
  });

  it("returns 'windows' on win32", () => {
    mockPlatform("win32");
    expect(getPlatform()).toBe("windows");
  });
});

// ---------------------------------------------------------------------------
// ServiceManager — macOS (launchd)
// ---------------------------------------------------------------------------

describe("ServiceManager (macOS)", () => {
  beforeEach(() => {
    mockPlatform("darwin");
  });

  it("install() writes a plist file", async () => {
    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    expect(mockFs.mkdir).toHaveBeenCalled();
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.plist"),
      expect.stringContaining("<key>Label</key>"),
      "utf-8",
    );
  });

  it("install() plist contains ProgramArguments with execPath", async () => {
    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    const plistContent = mockFs.writeFile.mock.calls[0][1] as string;
    expect(plistContent).toContain(sampleConfig.execPath);
    expect(plistContent).toContain(sampleConfig.cliPath);
    expect(plistContent).toContain("ISOTOPES_DAEMON");
  });

  it("uninstall() removes plist file", async () => {
    // disable will fail (best-effort), that's fine
    mockExec.mockRejectedValueOnce(new Error("not loaded"));

    const svc = new ServiceManager();
    await svc.uninstall("ai.isotopes.daemon");

    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.plist"),
    );
  });

  it("enable() calls launchctl load", async () => {
    const svc = new ServiceManager();
    await svc.enable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("launchctl load"),
    );
  });

  it("disable() calls launchctl unload", async () => {
    const svc = new ServiceManager();
    await svc.disable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("launchctl unload"),
    );
  });

  it("isInstalled() returns true when plist exists", async () => {
    mockFs.access.mockResolvedValue(undefined);

    const svc = new ServiceManager();
    expect(await svc.isInstalled("ai.isotopes.daemon")).toBe(true);
  });

  it("isInstalled() returns false when plist missing", async () => {
    mockFs.access.mockRejectedValue(new Error("ENOENT"));

    const svc = new ServiceManager();
    expect(await svc.isInstalled("ai.isotopes.daemon")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ServiceManager — Linux (systemd)
// ---------------------------------------------------------------------------

describe("ServiceManager (Linux)", () => {
  beforeEach(() => {
    mockPlatform("linux");
  });

  it("install() writes a unit file and reloads systemd", async () => {
    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.service"),
      expect.stringContaining("[Unit]"),
      "utf-8",
    );
    expect(mockExec).toHaveBeenCalledWith("systemctl --user daemon-reload");
  });

  it("install() unit file contains ExecStart with paths", async () => {
    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    const unitContent = mockFs.writeFile.mock.calls[0][1] as string;
    expect(unitContent).toContain(
      `ExecStart=${sampleConfig.execPath} ${sampleConfig.cliPath}`,
    );
    expect(unitContent).toContain("ISOTOPES_DAEMON=1");
    expect(unitContent).toContain("Restart=on-failure");
  });

  it("uninstall() removes unit file and reloads", async () => {
    // disable best-effort
    mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const svc = new ServiceManager();
    await svc.uninstall("ai.isotopes.daemon");

    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.service"),
    );
  });

  it("enable() calls systemctl enable", async () => {
    const svc = new ServiceManager();
    await svc.enable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      "systemctl --user enable ai.isotopes.daemon",
    );
  });

  it("disable() calls systemctl disable", async () => {
    const svc = new ServiceManager();
    await svc.disable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      "systemctl --user disable ai.isotopes.daemon",
    );
  });

  it("isInstalled() checks for unit file", async () => {
    mockFs.access.mockResolvedValue(undefined);

    const svc = new ServiceManager();
    expect(await svc.isInstalled("ai.isotopes.daemon")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ServiceManager — Windows (schtasks)
// ---------------------------------------------------------------------------

describe("ServiceManager (Windows)", () => {
  beforeEach(() => {
    mockPlatform("win32");
  });

  it("install() writes a .cmd script and creates a scheduled task", async () => {
    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.cmd"),
      expect.stringMatching(/^set ISOTOPES_DAEMON=1$/m),
      "utf-8",
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("schtasks /Create"),
    );
  });

  it("install() .cmd script contains exec and cli paths", async () => {
    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    const cmdContent = mockFs.writeFile.mock.calls[0][1] as string;
    expect(cmdContent).toContain(sampleConfig.execPath);
    expect(cmdContent).toContain(sampleConfig.cliPath);
  });

  it("uninstall() deletes the scheduled task and .cmd script", async () => {
    const svc = new ServiceManager();
    await svc.uninstall("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("schtasks /Delete"),
    );
    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.cmd"),
    );
  });

  it("enable() calls schtasks /Change /ENABLE", async () => {
    const svc = new ServiceManager();
    await svc.enable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("schtasks /Change"),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("/ENABLE"),
    );
  });

  it("disable() calls schtasks /Change /DISABLE", async () => {
    const svc = new ServiceManager();
    await svc.disable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("/DISABLE"),
    );
  });

  it("isInstalled() queries schtasks", async () => {
    mockExec.mockResolvedValue({ stdout: "TaskName: ...", stderr: "" });

    const svc = new ServiceManager();
    expect(await svc.isInstalled("ai.isotopes.daemon")).toBe(true);
  });

  it("isInstalled() returns false when task not found", async () => {
    mockExec.mockRejectedValue(new Error("ERROR: The system cannot find the file specified"));

    const svc = new ServiceManager();
    expect(await svc.isInstalled("ai.isotopes.daemon")).toBe(false);
  });

  it("install() falls back to Startup folder when schtasks fails", async () => {
    // First call is writeFile for .cmd script (succeeds),
    // then execAsync for schtasks /Create (fails),
    // then writeFile for startup folder fallback
    mockExec.mockRejectedValue(new Error("Access is denied"));

    const svc = new ServiceManager();
    await svc.install(sampleConfig);

    // The fallback should write to the Startup folder
    const fallbackCall = mockFs.writeFile.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes("Startup"),
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall![0]).toContain("ai.isotopes.daemon.cmd");
    expect(fallbackCall![1]).toMatch(/^set ISOTOPES_DAEMON=1$/m);
  });
});

// ---------------------------------------------------------------------------
// Unsupported platform
// ---------------------------------------------------------------------------

describe("ServiceManager (unsupported)", () => {
  beforeEach(() => {
    mockPlatform("freebsd" as NodeJS.Platform);
  });

  it("install() throws on unsupported platform", async () => {
    const svc = new ServiceManager();
    await expect(svc.install(sampleConfig)).rejects.toThrow("not supported");
  });

  it("uninstall() throws on unsupported platform", async () => {
    const svc = new ServiceManager();
    await expect(svc.uninstall("ai.isotopes.daemon")).rejects.toThrow(
      "not supported",
    );
  });

  it("isInstalled() returns false", async () => {
    const svc = new ServiceManager();
    expect(await svc.isInstalled("ai.isotopes.daemon")).toBe(false);
  });
});
