// src/sandbox/fs-bridge.test.ts — Unit tests for SandboxFs and FsError
//
// SandboxExecutor is mocked. Reads are passthroughs to host fs (covered
// implicitly by the type — we only verify the call shape doesn't throw).
// Writes route through executor.execute with stdin option.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxFs, FsError, mapStderrToCode } from "./fs-bridge.js";
import type { SandboxExecutor } from "./executor.js";

function makeExecutor(): SandboxExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  } as unknown as SandboxExecutor;
}

describe("SandboxFs", () => {
  let executor: SandboxExecutor;
  let fs: SandboxFs;

  beforeEach(() => {
    executor = makeExecutor();
    fs = new SandboxFs(executor, "agent-1");
  });

  describe("writeFile", () => {
    it("calls executor.execute with `cat > path` and pipes content via stdin", async () => {
      await fs.writeFile("/abs/path", "hello world");

      expect(executor.execute).toHaveBeenCalledWith(
        "agent-1",
        ["sh", "-c", "cat > '/abs/path'"],
        { stdin: "hello world" },
      );
    });

    it("escapes single quotes in paths", async () => {
      await fs.writeFile("/tmp/o'brien.txt", "x");

      expect(executor.execute).toHaveBeenCalledWith(
        "agent-1",
        ["sh", "-c", `cat > '/tmp/o'\\''brien.txt'`],
        { stdin: "x" },
      );
    });

    it("throws FsError on non-zero exit", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 1, stdout: "", stderr: "Permission denied\n",
      });

      await expect(fs.writeFile("/abs/path", "x")).rejects.toMatchObject({
        name: "FsError",
        code: "EACCES",
      });
    });
  });

  describe("mkdir", () => {
    it("invokes mkdir -p (always recursive), no stdin", async () => {
      await fs.mkdir("/abs/dir/deep");
      expect(executor.execute).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", `mkdir -p '/abs/dir/deep'`,
      ]);
    });

    it("throws FsError on non-zero exit", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory: File exists",
      });
      await expect(fs.mkdir("/abs/x")).rejects.toMatchObject({
        name: "FsError",
        code: "EEXIST",
      });
    });
  });

  describe("reads", () => {
    // Read methods passthrough to host fs; we only confirm callable shape.
    it("readFile / readdir / stat / exists / access are functions", () => {
      expect(typeof fs.readFile).toBe("function");
      expect(typeof fs.readdir).toBe("function");
      expect(typeof fs.stat).toBe("function");
      expect(typeof fs.exists).toBe("function");
      expect(typeof fs.access).toBe("function");
    });
  });
});

describe("mapStderrToCode", () => {
  it("maps common posix error strings", () => {
    expect(mapStderrToCode("rm: cannot remove '/x': No such file or directory")).toBe("ENOENT");
    expect(mapStderrToCode("mkdir: cannot create directory '/x': Permission denied")).toBe("EACCES");
    expect(mapStderrToCode("mkdir: cannot create directory '/x': File exists")).toBe("EEXIST");
    expect(mapStderrToCode("cat: /x: Is a directory")).toBe("EISDIR");
    expect(mapStderrToCode("cd: /x: Not a directory")).toBe("ENOTDIR");
    expect(mapStderrToCode("something weird happened")).toBe("EUNKNOWN");
  });
});

describe("FsError", () => {
  it("preserves code and message", () => {
    const e = new FsError("ENOENT", "missing");
    expect(e.code).toBe("ENOENT");
    expect(e.message).toBe("missing");
    expect(e.name).toBe("FsError");
  });
});
