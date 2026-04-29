// src/sandbox/fs-bridge.test.ts — Unit tests for SandboxFs and FsError
//
// SandboxExecutor is mocked. Reads are passthroughs to host fs (covered
// implicitly by the type — we only verify the call shape doesn't throw).
// Writes are routed through SandboxExecutor.execute / buildExecArgv.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import { SandboxFs, FsError, mapStderrToCode } from "./fs-bridge.js";
import type { SandboxExecutor } from "./executor.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(spawn);

function makeExecutor(): SandboxExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    buildExecArgv: vi.fn().mockResolvedValue(["docker", "exec", "-i", "ctr-1", "sh", "-c", "cat > '/abs/path'"]),
  } as unknown as SandboxExecutor;
}

/** Build a fake ChildProcess that exits with the given code/stderr after stdin.end. */
function fakeChild(opts: { code: number; stderr?: string; capture?: { chunks: Buffer[] } }): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  const stderrStream = Readable.from(opts.stderr ? [Buffer.from(opts.stderr)] : []);
  const stdoutStream = Readable.from([]);
  let stdinEnded = false;
  const stdinStream = new Writable({
    write(chunk, _enc, cb) {
      if (opts.capture) opts.capture.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      cb();
    },
    final(cb) {
      stdinEnded = true;
      // Defer close until after stdin closes, mimicking docker exec behavior.
      setImmediate(() => ee.emit("close", opts.code));
      cb();
    },
  });
  Object.defineProperty(ee, "stdin", { value: stdinStream });
  Object.defineProperty(ee, "stdout", { value: stdoutStream });
  Object.defineProperty(ee, "stderr", { value: stderrStream });
  // Touch stdinEnded so eslint doesn't complain about unused
  void stdinEnded;
  return ee;
}

describe("SandboxFs", () => {
  let executor: SandboxExecutor;
  let fs: SandboxFs;

  beforeEach(() => {
    executor = makeExecutor();
    fs = new SandboxFs(executor, "agent-1");
    mockSpawn.mockReset();
  });

  describe("writeFile", () => {
    it("spawns docker exec via buildExecArgv and pipes content via stdin", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0 }));

      await fs.writeFile("/abs/path", "hello world");

      expect(executor.buildExecArgv).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", "cat > '/abs/path'",
      ]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [bin, args] = mockSpawn.mock.calls[0];
      expect(bin).toBe("docker");
      expect(args).toEqual(["exec", "-i", "ctr-1", "sh", "-c", "cat > '/abs/path'"]);
    });

    it("rejects with FsError when docker exec exits non-zero", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 1, stderr: "Permission denied\n" }));

      await expect(fs.writeFile("/abs/path", "x")).rejects.toMatchObject({
        name: "FsError",
        code: "EACCES",
      });
    });

    it("escapes single quotes in paths", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0 }));

      await fs.writeFile("/tmp/o'brien.txt", "x");

      expect(executor.buildExecArgv).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", `cat > '/tmp/o'\\''brien.txt'`,
      ]);
    });

    it("pipes raw bytes for Buffer input (no utf-8 round-trip corruption)", async () => {
      const capture = { chunks: [] as Buffer[] };
      mockSpawn.mockReturnValue(fakeChild({ code: 0, capture }));

      // Bytes that are NOT valid utf-8 — would be mangled by toString("utf-8")
      const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]);
      await fs.writeFile("/abs/path", payload);

      const written = Buffer.concat(capture.chunks);
      expect(Array.from(written)).toEqual([0xff, 0xfe, 0x00, 0x80, 0x81]);
    });

    it("pipes raw bytes for Uint8Array input", async () => {
      const capture = { chunks: [] as Buffer[] };
      mockSpawn.mockReturnValue(fakeChild({ code: 0, capture }));

      const payload = new Uint8Array([1, 2, 3, 4, 0xff]);
      await fs.writeFile("/abs/path", payload);

      const written = Buffer.concat(capture.chunks);
      expect(Array.from(written)).toEqual([1, 2, 3, 4, 0xff]);
    });

    it("encodes string input as utf-8", async () => {
      const capture = { chunks: [] as Buffer[] };
      mockSpawn.mockReturnValue(fakeChild({ code: 0, capture }));

      await fs.writeFile("/abs/path", "héllo 😀");

      const written = Buffer.concat(capture.chunks);
      expect(written.toString("utf8")).toBe("héllo 😀");
    });

    it("rejects unsupported data types with FsError", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0 }));

      await expect(fs.writeFile("/abs/path", 42 as unknown as string)).rejects.toMatchObject({
        name: "FsError",
        code: "EUNKNOWN",
      });
    });
  });

  describe("mkdir", () => {
    it("invokes mkdir without -p by default", async () => {
      await fs.mkdir("/abs/dir");
      expect(executor.execute).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", `mkdir '/abs/dir'`,
      ]);
    });

    it("invokes mkdir -p when recursive: true", async () => {
      await fs.mkdir("/abs/dir/deep", { recursive: true });
      expect(executor.execute).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", `mkdir -p '/abs/dir/deep'`,
      ]);
    });

    it("throws FsError on non-zero exit", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "mkdir: cannot create directory: File exists",
      });
      await expect(fs.mkdir("/abs/x")).rejects.toMatchObject({
        name: "FsError",
        code: "EEXIST",
      });
    });
  });

  describe("unlink", () => {
    it("invokes rm with -- and quoted path", async () => {
      await fs.unlink("/abs/file");
      expect(executor.execute).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", `rm -- '/abs/file'`,
      ]);
    });
  });

  describe("rename", () => {
    it("invokes mv with -- and both quoted paths", async () => {
      await fs.rename("/from", "/to");
      expect(executor.execute).toHaveBeenCalledWith("agent-1", [
        "sh", "-c", `mv -- '/from' '/to'`,
      ]);
    });
  });

  describe("reads", () => {
    // The read methods are bound to nodeFs; we don't re-test node:fs/promises
    // here. Instead we just confirm they're callable as methods (i.e. that
    // typing them with the proper FsLike signatures didn't break dispatch).
    it("readFile / readdir / stat are functions", () => {
      expect(typeof fs.readFile).toBe("function");
      expect(typeof fs.readdir).toBe("function");
      expect(typeof fs.stat).toBe("function");
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
