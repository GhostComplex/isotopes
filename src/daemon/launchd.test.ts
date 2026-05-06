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

describe("launchd.install", () => {
  it("writes a plist with Label, ProgramArguments, RunAtLoad=true, KeepAlive=true", async () => {
    await launchd.install(sampleConfig);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.plist"),
      expect.stringContaining("<key>Label</key>"),
      "utf-8",
    );
    const plist = mockFs.writeFile.mock.calls[0][1] as string;
    expect(plist).toContain(sampleConfig.execPath);
    expect(plist).toContain(sampleConfig.cliPath);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  it("does not embed the legacy ISOTOPES_DAEMON env var", async () => {
    await launchd.install(sampleConfig);

    const plist = mockFs.writeFile.mock.calls[0][1] as string;
    expect(plist).not.toContain("ISOTOPES_DAEMON");
  });

  it("XML-escapes plist string fields", async () => {
    await launchd.install({
      ...sampleConfig,
      logPath: "/path/with & and <chars>.log",
    });

    const plist = mockFs.writeFile.mock.calls[0][1] as string;
    expect(plist).toContain("/path/with &amp; and &lt;chars&gt;.log");
    expect(plist).not.toContain("/path/with & and <chars>.log");
  });

  it("invokes launchctl bootout then bootstrap (idempotent reload)", async () => {
    await launchd.install(sampleConfig);

    const calls = mockExec.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("launchctl bootout"))).toBe(true);
    expect(calls.some((c) => c.includes("launchctl bootstrap"))).toBe(true);
    // bootout comes before bootstrap
    const bootoutIdx = calls.findIndex((c) => c.includes("launchctl bootout"));
    const bootstrapIdx = calls.findIndex((c) => c.includes("launchctl bootstrap"));
    expect(bootoutIdx).toBeLessThan(bootstrapIdx);
  });

  it("uses gui/<uid>/<label> domain target for bootout", async () => {
    await launchd.install(sampleConfig);

    const calls = mockExec.mock.calls.map((c) => c[0] as string);
    const bootout = calls.find((c) => c.includes("launchctl bootout"));
    expect(bootout).toMatch(/launchctl bootout gui\/\d+\/ai\.isotopes\.daemon/);
  });

  it("succeeds even when the agent isn't currently loaded (bootout fails silently)", async () => {
    mockExec
      .mockRejectedValueOnce(new Error("not loaded"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(launchd.install(sampleConfig)).resolves.toBeUndefined();
  });
});

describe("launchd.uninstall", () => {
  it("calls launchctl bootout then deletes the plist file", async () => {
    await launchd.uninstall("ai.isotopes.daemon");

    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("launchctl bootout"));
    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("ai.isotopes.daemon.plist"),
    );
  });

  it("still deletes the plist when launchctl bootout fails", async () => {
    mockExec.mockRejectedValueOnce(new Error("not loaded"));

    await launchd.uninstall("ai.isotopes.daemon");

    expect(mockFs.unlink).toHaveBeenCalled();
  });
});

describe("launchd.restart", () => {
  it("calls launchctl kickstart -k with gui/<uid>/<label> domain target", async () => {
    await launchd.restart("ai.isotopes.daemon");

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toMatch(/launchctl kickstart -k gui\/\d+\/ai\.isotopes\.daemon/);
  });

  it("propagates launchctl errors (e.g. agent not loaded)", async () => {
    mockExec.mockRejectedValueOnce(new Error("Could not find specified service"));

    await expect(launchd.restart("ai.isotopes.daemon")).rejects.toThrow();
  });
});

describe("launchd.status", () => {
  it("returns running with pid when launchctl reports a numeric pid", async () => {
    mockExec.mockResolvedValueOnce({ stdout: "12345\t0\tai.isotopes.daemon\n", stderr: "" });

    const s = await launchd.status("ai.isotopes.daemon");
    expect(s).toEqual({ state: "running", pid: 12345 });
  });

  it("returns loaded when launchctl reports '-' as pid", async () => {
    mockExec.mockResolvedValueOnce({ stdout: "-\t0\tai.isotopes.daemon\n", stderr: "" });

    const s = await launchd.status("ai.isotopes.daemon");
    expect(s).toEqual({ state: "loaded" });
  });

  it("returns not-installed when launchctl exits non-zero", async () => {
    mockExec.mockRejectedValueOnce(new Error("Could not find specified service"));

    const s = await launchd.status("ai.isotopes.daemon");
    expect(s).toEqual({ state: "not-installed" });
  });
});
