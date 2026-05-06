import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxFs, FsError, mapStderrToCode } from "./fs.js";
import type { SandboxExecutor } from "./executor.js";

function makeExecutor(): SandboxExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }),
  } as unknown as SandboxExecutor;
}

describe("SandboxFs", () => {
  let executor: SandboxExecutor;
  let fs: SandboxFs;

  beforeEach(() => {
    executor = makeExecutor();
    fs = new SandboxFs(executor, "agent-1");
  });

  describe("readFile", () => {
    it("calls `cat path` and returns stdout as Buffer", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.from("file contents"),
        stderr: Buffer.alloc(0),
      });

      const result = await fs.readFile("/abs/path");

      expect(executor.execute).toHaveBeenCalledWith("agent-1", ["cat", "/abs/path"]);
      expect(result).toEqual(Buffer.from("file contents"));
    });

    it("throws FsError on non-zero exit", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("cat: /x: No such file or directory\n"),
      });

      await expect(fs.readFile("/abs/path")).rejects.toMatchObject({
        name: "FsError",
        code: "ENOENT",
      });
    });
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
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("Permission denied\n"),
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
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("mkdir: cannot create directory: File exists"),
      });
      await expect(fs.mkdir("/abs/x")).rejects.toMatchObject({
        name: "FsError",
        code: "EEXIST",
      });
    });
  });

  describe("stat", () => {
    it("returns isDirectory=true for a directory", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.from("directory\n"),
        stderr: Buffer.alloc(0),
      });

      const result = await fs.stat("/abs/dir");

      expect(executor.execute).toHaveBeenCalledWith("agent-1", ["stat", "-c", "%F", "/abs/dir"]);
      expect(result.isDirectory()).toBe(true);
    });

    it("returns isDirectory=false for a regular file", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.from("regular file\n"),
        stderr: Buffer.alloc(0),
      });

      const result = await fs.stat("/abs/file");
      expect(result.isDirectory()).toBe(false);
    });
  });

  describe("readdir", () => {
    it("splits ls output into entries", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.from("a.txt\nb.txt\n.hidden\n"),
        stderr: Buffer.alloc(0),
      });

      const result = await fs.readdir("/abs/dir");

      expect(executor.execute).toHaveBeenCalledWith("agent-1", ["ls", "-1A", "/abs/dir"]);
      expect(result).toEqual(["a.txt", "b.txt", ".hidden"]);
    });
  });

  describe("exists", () => {
    it("returns true when test -e succeeds", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      expect(await fs.exists("/abs/file")).toBe(true);
    });

    it("returns false when test -e fails", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      expect(await fs.exists("/abs/missing")).toBe(false);
    });
  });

  describe("access", () => {
    it("throws EACCES when test -r fails", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      await expect(fs.access("/abs/forbidden")).rejects.toMatchObject({
        name: "FsError",
        code: "EACCES",
      });
    });

    it("resolves when readable", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      await expect(fs.access("/abs/ok")).resolves.toBeUndefined();
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
