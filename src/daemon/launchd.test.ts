import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import * as launchd from "./launchd.js";
import type { LaunchAgentConfig } from "./launchd.js";

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

const sampleConfig: LaunchAgentConfig = {
  name: "ai.isotopes.daemon",
  execPath: "/usr/local/bin/node",
  cliPath: "/usr/local/lib/isotopes/dist/cli.js",
  logPath: "/Users/me/.isotopes/logs/isotopes.out.log",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("launchd", () => {
  it("install() writes a plist file", async () => {
    await launchd.install(sampleConfig);

    expect(mockFs.mkdir).toHaveBeenCalled();
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.plist"),
      expect.stringContaining("<key>Label</key>"),
      "utf-8",
    );
  });

  it("install() plist embeds execPath, cliPath, and ISOTOPES_DAEMON env var", async () => {
    await launchd.install(sampleConfig);

    const plistContent = mockFs.writeFile.mock.calls[0][1] as string;
    expect(plistContent).toContain(sampleConfig.execPath);
    expect(plistContent).toContain(sampleConfig.cliPath);
    expect(plistContent).toContain("ISOTOPES_DAEMON");
  });

  it("uninstall() removes the plist file (after best-effort disable)", async () => {
    mockExec.mockRejectedValueOnce(new Error("not loaded"));

    await launchd.uninstall("ai.isotopes.daemon");

    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.plist"),
    );
  });

  it("enable() calls launchctl load", async () => {
    await launchd.enable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("launchctl load"));
  });

  it("disable() calls launchctl unload", async () => {
    await launchd.disable("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"));
  });

  it("isInstalled() returns true when plist exists", async () => {
    mockFs.access.mockResolvedValue(undefined);

    expect(await launchd.isInstalled("ai.isotopes.daemon")).toBe(true);
  });

  it("isInstalled() returns false when plist missing", async () => {
    mockFs.access.mockRejectedValue(new Error("ENOENT"));

    expect(await launchd.isInstalled("ai.isotopes.daemon")).toBe(false);
  });
});
