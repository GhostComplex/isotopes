// src/sandbox/container.test.ts — Unit tests for ContainerManager
// All docker calls go through spawn (mocked via vi.mock("node:child_process")).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { ContainerManager } from "./container.js";
import type { DockerConfig } from "../../sandbox/config.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(spawn);

/** Build a fake ChildProcess that emits stdout/stderr then closes with `code` after stdin.end. */
function fakeChild(opts: { code: number; stdout?: string; stderr?: string; capture?: { chunks: Buffer[] } }): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  const stdoutStream = Readable.from(opts.stdout ? [Buffer.from(opts.stdout)] : []);
  const stderrStream = Readable.from(opts.stderr ? [Buffer.from(opts.stderr)] : []);
  const stdinStream = new Writable({
    write(chunk, _enc, cb) {
      if (opts.capture) opts.capture.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      cb();
    },
    final(cb) {
      setImmediate(() => ee.emit("close", opts.code));
      cb();
    },
  });
  Object.defineProperty(ee, "stdin", { value: stdinStream });
  Object.defineProperty(ee, "stdout", { value: stdoutStream });
  Object.defineProperty(ee, "stderr", { value: stderrStream });
  return ee;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContainerManager", () => {
  const defaultDockerConfig: DockerConfig = {
    image: "isotopes-sandbox:latest",
    network: "bridge",
  };

  let manager: ContainerManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    manager = new ContainerManager();
  });

  describe("create", () => {
    it("calls docker create with correct arguments", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));

      const result = await manager.create("test-container", "/home/user/workspace", "rw", [], defaultDockerConfig);

      expect(mockSpawn).toHaveBeenCalledWith("docker", [
        "create",
        "--name", "test-container",
        "--init",
        "-v", "/home/user/workspace:/home/user/workspace",
        "-w", "/home/user/workspace",
        "--network", "bridge",
        "--security-opt", "no-new-privileges",
        "isotopes-sandbox:latest",
        "tail", "-f", "/dev/null",
      ], { stdio: ["pipe", "pipe", "pipe"] });

      expect(result.id).toBe("abc123");
      expect(result.name).toBe("test-container");
      expect(result.status).toBe("created");
      expect(result.image).toBe("isotopes-sandbox:latest");
    });

    it("emits hardening flags when DockerConfig provides them", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));

      const hardened: DockerConfig = {
        ...defaultDockerConfig,
        pidsLimit: 256,
        noNewPrivileges: true,
      };

      await manager.create("hardened", "/workspace", "rw", [], hardened);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--init");
      expect(args).toContain("--pids-limit");
      expect(args).toContain("256");
      expect(args).toContain("--security-opt");
      expect(args).toContain("no-new-privileges");
    });

    it("omits --pids-limit when set to 0", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));
      const cfg: DockerConfig = { ...defaultDockerConfig, pidsLimit: 0 };
      await manager.create("t", "/w", "rw", [], cfg);
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--pids-limit");
    });

    it("omits --security-opt when noNewPrivileges is false", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));
      const cfg: DockerConfig = { ...defaultDockerConfig, noNewPrivileges: false };
      await manager.create("t", "/w", "rw", [], cfg);
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--security-opt");
    });

    it("adds :ro suffix for read-only workspace access", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));

      await manager.create("test-container", "/workspace", "ro", [], defaultDockerConfig);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("/workspace:/workspace:ro");
    });

    it("includes extra hosts in create args", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));

      const configWithHosts: DockerConfig = {
        ...defaultDockerConfig,
        extraHosts: ["host.docker.internal:host-gateway", "myhost:192.168.1.1"],
      };

      await manager.create("test", "/workspace", "rw", [], configWithHosts);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--add-host");
      expect(args).toContain("host.docker.internal:host-gateway");
      expect(args).toContain("myhost:192.168.1.1");
    });

    it("includes CPU and memory limits in create args", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc123\n" }));

      const configWithLimits: DockerConfig = {
        ...defaultDockerConfig,
        cpuLimit: 1.5,
        memoryLimit: "512m",
      };

      await manager.create("test", "/workspace", "rw", [], configWithLimits);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--cpus");
      expect(args).toContain("1.5");
      expect(args).toContain("--memory");
      expect(args).toContain("512m");
    });

    it("emits user mounts as -v with optional :ro suffix", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc\n" }));

      await manager.create("test", "/workspace", "rw", [
        { host: "/host/data", container: "/data", readOnly: true },
        { host: "/host/scratch", container: "/scratch", readOnly: false },
      ], defaultDockerConfig);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("/host/data:/data:ro");
      expect(args).toContain("/host/scratch:/scratch");
    });

    it("does not duplicate workspace mount when included in mounts", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "abc\n" }));

      await manager.create("test", "/workspace", "rw", [
        { host: "/workspace", container: "/workspace", readOnly: true },
        { host: "/extra", container: "/extra" },
      ], defaultDockerConfig);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("/workspace:/workspace:ro");
      expect(args).toContain("/extra:/extra");
    });
  });

  describe("start", () => {
    it("calls docker start with container ID", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "" }));

      await manager.start("abc123");

      expect(mockSpawn).toHaveBeenCalledWith("docker", ["start", "abc123"], { stdio: ["pipe", "pipe", "pipe"] });
    });
  });

  describe("stop", () => {
    it("calls docker stop with default timeout", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "" }));

      await manager.stop("abc123");

      expect(mockSpawn).toHaveBeenCalledWith("docker", [
        "stop", "-t", "10", "abc123",
      ], { stdio: ["pipe", "pipe", "pipe"] });
    });

    it("calls docker stop with custom timeout", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "" }));

      await manager.stop("abc123", 30);

      expect(mockSpawn).toHaveBeenCalledWith("docker", [
        "stop", "-t", "30", "abc123",
      ], { stdio: ["pipe", "pipe", "pipe"] });
    });
  });

  describe("remove", () => {
    it("calls docker rm without force by default", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "" }));

      await manager.remove("abc123");

      expect(mockSpawn).toHaveBeenCalledWith("docker", ["rm", "abc123"], { stdio: ["pipe", "pipe", "pipe"] });
    });

    it("calls docker rm with force flag", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "" }));

      await manager.remove("abc123", true);

      expect(mockSpawn).toHaveBeenCalledWith("docker", [
        "rm", "--force", "abc123",
      ], { stdio: ["pipe", "pipe", "pipe"] });
    });
  });

  describe("exec", () => {
    it("spawns docker exec and returns stdout/stderr/exitCode", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: "hello world\n" }));

      const result = await manager.exec("abc123", ["echo", "hello world"]);

      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        ["exec", "-i", "abc123", "echo", "hello world"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("hello world\n");
      expect(result.stderr.toString("utf8")).toBe("");
    });

    it("returns non-zero exit code on command failure", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 1, stderr: "command not found\n" }));

      const result = await manager.exec("abc123", ["nonexistent"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString("utf8")).toBe("command not found\n");
    });

    it("rejects on spawn-level errors (e.g. docker missing)", async () => {
      const ee = new EventEmitter() as ChildProcess;
      Object.defineProperty(ee, "stdin", { value: new Writable({ write(_c, _e, cb) { cb(); }, final(cb) { cb(); } }) });
      Object.defineProperty(ee, "stdout", { value: Readable.from([]) });
      Object.defineProperty(ee, "stderr", { value: Readable.from([]) });
      mockSpawn.mockReturnValue(ee);
      setImmediate(() => ee.emit("error", new Error("Docker daemon not running")));

      await expect(manager.exec("abc123", ["echo"])).rejects.toThrow("Docker daemon not running");
    });

    it("pipes stdin when options.stdin is provided", async () => {
      const capture = { chunks: [] as Buffer[] };
      mockSpawn.mockReturnValue(fakeChild({ code: 0, capture }));

      await manager.exec("abc123", ["sh", "-c", "cat > /tmp/x"], { stdin: "file body" });

      const written = Buffer.concat(capture.chunks);
      expect(written.toString("utf8")).toBe("file body");
    });
    it("preserves multi-byte UTF-8 split across chunk boundaries", async () => {
      // "你好" is 6 bytes (E4 BD A0  E5 A5 BD); split mid-character.
      const bytes = Buffer.from("你好", "utf8");
      const part1 = bytes.subarray(0, 4);  // mid-second-char
      const part2 = bytes.subarray(4);

      const ee = new EventEmitter() as ChildProcess;
      const stdout = new Readable({ read() {} });
      const stderr = Readable.from([]);
      const stdin = new Writable({ write(_c, _e, cb) { cb(); }, final(cb) { cb(); } });
      Object.defineProperty(ee, "stdin", { value: stdin });
      Object.defineProperty(ee, "stdout", { value: stdout });
      Object.defineProperty(ee, "stderr", { value: stderr });
      mockSpawn.mockReturnValue(ee);

      const promise = manager.exec("abc123", ["echo", "你好"]);
      stdout.push(part1);
      stdout.push(part2);
      stdout.push(null);
      setImmediate(() => ee.emit("close", 0));

      const result = await promise;
      expect(result.stdout.toString("utf8")).toBe("你好");
    });

    it("flags truncation and appends marker when output exceeds 100KB", async () => {
      const cap = 100 * 1024;
      const huge = "x".repeat(cap + 50 * 1024);
      mockSpawn.mockReturnValue(fakeChild({ code: 0, stdout: huge }));

      const result = await manager.exec("abc123", ["cat", "/big/file"]);

      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBe(cap + `\n[output truncated at ${cap} bytes]`.length);
      expect(result.stdout.toString("utf8").endsWith(`[output truncated at ${cap} bytes]`)).toBe(true);
    });

  });

  describe("buildExecArgv", () => {
    it("returns docker exec argv with -i and the command tokens", () => {
      const argv = manager.buildExecArgv("abc123", ["sh", "-c", "echo hi"]);
      expect(argv).toEqual(["docker", "exec", "-i", "abc123", "sh", "-c", "echo hi"]);
    });
  });

  describe("status", () => {
    it("returns container info when container exists", async () => {
      mockSpawn.mockReturnValue(fakeChild({
        code: 0,
        stdout: "abc123\t/test-container\trunning\tisotopes-sandbox:latest\t2026-04-09T10:00:00Z\n",
      }));

      const info = await manager.status("abc123");

      expect(info).not.toBeNull();
      expect(info!.id).toBe("abc123");
      expect(info!.name).toBe("test-container");
      expect(info!.status).toBe("running");
      expect(info!.image).toBe("isotopes-sandbox:latest");
    });

    it("strips leading / from container name", async () => {
      mockSpawn.mockReturnValue(fakeChild({
        code: 0,
        stdout: "abc123\t/my-container\trunning\ttest:latest\t2026-04-09T10:00:00Z\n",
      }));

      const info = await manager.status("abc123");

      expect(info!.name).toBe("my-container");
    });

    it("returns null when container does not exist", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 1, stderr: "No such container" }));

      const info = await manager.status("nonexistent");

      expect(info).toBeNull();
    });
  });

  describe("status normalization", () => {
    it.each([
      ["Up 2 minutes", "running"],
      ["running", "running"],
      ["Exited (0) 5 minutes ago", "exited"],
      ["exited", "exited"],
      ["created", "created"],
      ["Up 3 hours (Paused)", "paused"],
      ["paused", "paused"],
      ["dead", "exited"],
    ] as const)("normalizes '%s' to '%s'", async (dockerStatus, expected) => {
      mockSpawn.mockReturnValue(fakeChild({
        code: 0,
        stdout: `abc123\t/test\t${dockerStatus}\ttest:latest\t2026-04-09T10:00:00Z\n`,
      }));

      const info = await manager.status("abc123");

      expect(info!.status).toBe(expected);
    });
  });
});
