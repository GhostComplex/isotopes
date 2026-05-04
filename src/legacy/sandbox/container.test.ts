// src/sandbox/container.test.ts — Unit tests for ContainerManager
// Lifecycle docker calls are mocked via vi.mock("node:util") for execFile;
// `exec()` uses spawn directly (mocked via vi.mock("node:child_process")).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { ContainerManager } from "./container.js";
import type { DockerConfig } from "./config.js";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

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
    mockExecFile.mockReset();
    mockSpawn.mockReset();
    manager = new ContainerManager(defaultDockerConfig);
  });

  describe("create", () => {
    it("calls docker create with correct arguments", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });

      const result = await manager.create("test-container", "/home/user/workspace", "rw");

      expect(mockExecFile).toHaveBeenCalledWith("docker", [
        "create",
        "--name", "test-container",
        "--init",
        "-v", "/home/user/workspace:/home/user/workspace",
        "-w", "/home/user/workspace",
        "--network", "bridge",
        "--security-opt", "no-new-privileges",
        "isotopes-sandbox:latest",
        "tail", "-f", "/dev/null",
      ]);

      expect(result.id).toBe("abc123");
      expect(result.name).toBe("test-container");
      expect(result.status).toBe("created");
      expect(result.image).toBe("isotopes-sandbox:latest");
    });

    it("emits hardening flags when DockerConfig provides them", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });

      const hardened: DockerConfig = {
        ...defaultDockerConfig,
        pidsLimit: 256,
        capDrop: ["ALL"],
        capAdd: ["DAC_OVERRIDE", "CHOWN", "FOWNER"],
        noNewPrivileges: true,
      };
      const m = new ContainerManager(hardened);

      await m.create("hardened", "/workspace", "rw");

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--init");
      expect(args).toContain("--pids-limit");
      expect(args).toContain("256");
      expect(args.filter((a) => a === "--cap-drop")).toHaveLength(1);
      expect(args).toContain("ALL");
      expect(args.filter((a) => a === "--cap-add")).toHaveLength(3);
      expect(args).toContain("DAC_OVERRIDE");
      expect(args).toContain("--security-opt");
      expect(args).toContain("no-new-privileges");
    });

    it("omits --pids-limit when set to 0", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });
      const cfg: DockerConfig = { ...defaultDockerConfig, pidsLimit: 0 };
      await new ContainerManager(cfg).create("t", "/w", "rw");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("--pids-limit");
    });

    it("omits --security-opt when noNewPrivileges is false", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });
      const cfg: DockerConfig = { ...defaultDockerConfig, noNewPrivileges: false };
      await new ContainerManager(cfg).create("t", "/w", "rw");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("--security-opt");
    });

    it("adds :ro suffix for read-only workspace access", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });

      await manager.create("test-container", "/workspace", "ro");

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("/workspace:/workspace:ro");
    });

    it("includes extra hosts in create args", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });

      const configWithHosts: DockerConfig = {
        ...defaultDockerConfig,
        extraHosts: ["host.docker.internal:host-gateway", "myhost:192.168.1.1"],
      };
      const m = new ContainerManager(configWithHosts);

      await m.create("test", "/workspace", "rw");

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--add-host");
      expect(args).toContain("host.docker.internal:host-gateway");
      expect(args).toContain("myhost:192.168.1.1");
    });

    it("includes CPU and memory limits in create args", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc123\n", stderr: "" });

      const configWithLimits: DockerConfig = {
        ...defaultDockerConfig,
        cpuLimit: 1.5,
        memoryLimit: "512m",
      };
      const m = new ContainerManager(configWithLimits);

      await m.create("test", "/workspace", "rw");

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--cpus");
      expect(args).toContain("1.5");
      expect(args).toContain("--memory");
      expect(args).toContain("512m");
    });

    it("mounts allowedWorkspaces as read-only at host path", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc\n", stderr: "" });

      await manager.create("test", "/workspace", "rw", ["/extra/foo", "/another/bar"]);

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("/extra/foo:/extra/foo:ro");
      expect(args).toContain("/another/bar:/another/bar:ro");
    });

    it("does not duplicate workspace mount when included in allowedWorkspaces", async () => {
      mockExecFile.mockResolvedValue({ stdout: "abc\n", stderr: "" });

      await manager.create("test", "/workspace", "rw", ["/workspace", "/extra"]);

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("/workspace:/workspace:ro");
      expect(args).toContain("/extra:/extra:ro");
    });
  });

  describe("start", () => {
    it("calls docker start with container ID", async () => {
      mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.start("abc123");

      expect(mockExecFile).toHaveBeenCalledWith("docker", ["start", "abc123"]);
    });
  });

  describe("stop", () => {
    it("calls docker stop with default timeout", async () => {
      mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.stop("abc123");

      expect(mockExecFile).toHaveBeenCalledWith("docker", [
        "stop", "-t", "10", "abc123",
      ]);
    });

    it("calls docker stop with custom timeout", async () => {
      mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.stop("abc123", 30);

      expect(mockExecFile).toHaveBeenCalledWith("docker", [
        "stop", "-t", "30", "abc123",
      ]);
    });
  });

  describe("remove", () => {
    it("calls docker rm without force by default", async () => {
      mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.remove("abc123");

      expect(mockExecFile).toHaveBeenCalledWith("docker", ["rm", "abc123"]);
    });

    it("calls docker rm with force flag", async () => {
      mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.remove("abc123", true);

      expect(mockExecFile).toHaveBeenCalledWith("docker", [
        "rm", "--force", "abc123",
      ]);
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
      expect(result.stdout).toBe("hello world\n");
      expect(result.stderr).toBe("");
    });

    it("returns non-zero exit code on command failure", async () => {
      mockSpawn.mockReturnValue(fakeChild({ code: 1, stderr: "command not found\n" }));

      const result = await manager.exec("abc123", ["nonexistent"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("command not found\n");
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
  });

  describe("buildExecArgv", () => {
    it("returns docker exec argv with -i and the command tokens", () => {
      const argv = manager.buildExecArgv("abc123", ["sh", "-c", "echo hi"]);
      expect(argv).toEqual(["docker", "exec", "-i", "abc123", "sh", "-c", "echo hi"]);
    });
  });

  describe("status", () => {
    it("returns container info when container exists", async () => {
      mockExecFile.mockResolvedValue({
        stdout: "abc123\t/test-container\trunning\tisotopes-sandbox:latest\t2026-04-09T10:00:00Z\n",
        stderr: "",
      });

      const info = await manager.status("abc123");

      expect(info).not.toBeNull();
      expect(info!.id).toBe("abc123");
      expect(info!.name).toBe("test-container");
      expect(info!.status).toBe("running");
      expect(info!.image).toBe("isotopes-sandbox:latest");
    });

    it("strips leading / from container name", async () => {
      mockExecFile.mockResolvedValue({
        stdout: "abc123\t/my-container\trunning\ttest:latest\t2026-04-09T10:00:00Z\n",
        stderr: "",
      });

      const info = await manager.status("abc123");

      expect(info!.name).toBe("my-container");
    });

    it("returns null when container does not exist", async () => {
      mockExecFile.mockRejectedValue(new Error("No such container"));

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
      mockExecFile.mockResolvedValue({
        stdout: `abc123\t/test\t${dockerStatus}\ttest:latest\t2026-04-09T10:00:00Z\n`,
        stderr: "",
      });

      const info = await manager.status("abc123");

      expect(info!.status).toBe(expected);
    });
  });
});
