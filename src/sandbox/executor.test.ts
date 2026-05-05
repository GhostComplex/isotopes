// src/sandbox/executor.test.ts — Unit tests for SandboxExecutor
// ContainerManager is fully mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxExecutor } from "./executor.js";
import type { ContainerManager, ContainerInfo } from "./container.js";
import type { SandboxConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Mock ContainerManager
// ---------------------------------------------------------------------------

function createMockContainerManager(): ContainerManager {
  return {
    create: vi.fn<ContainerManager["create"]>().mockResolvedValue({
      id: "container-123",
      name: "isotopes-sandbox-test",
      status: "created",
      image: "isotopes-sandbox:latest",
      createdAt: new Date("2026-04-09T10:00:00Z"),
    }),
    start: vi.fn<ContainerManager["start"]>().mockResolvedValue(undefined),
    stop: vi.fn<ContainerManager["stop"]>().mockResolvedValue(undefined),
    remove: vi.fn<ContainerManager["remove"]>().mockResolvedValue(undefined),
    exec: vi.fn<ContainerManager["exec"]>().mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("output\n"),
      stderr: Buffer.alloc(0),
    }),
    status: vi.fn<ContainerManager["status"]>().mockResolvedValue({
      id: "container-123",
      name: "isotopes-sandbox-test",
      status: "running",
      image: "isotopes-sandbox:latest",
      createdAt: new Date("2026-04-09T10:00:00Z"),
    }),
    buildExecArgv: vi.fn<ContainerManager["buildExecArgv"]>((id, cmd) => [
      "docker", "exec", "-i", id, ...cmd,
    ]),
  } as unknown as ContainerManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SandboxExecutor", () => {
  const defaultConfig: SandboxConfig = {
    enabled: true,
    workspaceAccess: "rw",
    docker: { image: "isotopes-sandbox:latest", network: "bridge" },
  };

  let mockManager: ContainerManager;
  let executor: SandboxExecutor;

  beforeEach(() => {
    mockManager = createMockContainerManager();
    executor = new SandboxExecutor(mockManager, defaultConfig);
  });

  describe("execute", () => {
    it("creates and starts a container on first execution", async () => {
      const result = await executor.execute("agent-1", ["echo", "hello"], {
        workspacePath: "/home/user/workspace",
      });

      expect(mockManager.create).toHaveBeenCalledWith(
        "isotopes-sandbox-agent-1",
        "/home/user/workspace",
        "rw",
        [],
      );
      expect(mockManager.start).toHaveBeenCalledWith("container-123");
      expect(mockManager.exec).toHaveBeenCalledWith("container-123", [
        "echo",
        "hello",
      ], undefined);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("output\n");
    });

    it("reaps an orphan container left from a previous process", async () => {
      vi.mocked(mockManager.status).mockResolvedValueOnce({
        id: "orphan-id",
        name: "isotopes-sandbox-agent-1",
        status: "exited",
        image: "isotopes-sandbox:latest",
        createdAt: new Date(),
      });

      await executor.execute("agent-1", ["echo", "hello"]);

      expect(mockManager.status).toHaveBeenCalledWith("isotopes-sandbox-agent-1");
      expect(mockManager.stop).toHaveBeenCalledWith("orphan-id", 5);
      expect(mockManager.remove).toHaveBeenCalledWith("orphan-id", true);
      expect(mockManager.create).toHaveBeenCalledTimes(1);
    });

    it("reuses existing running container", async () => {
      // First execution creates the container
      await executor.execute("agent-1", ["echo", "first"]);

      // Second execution should reuse it
      await executor.execute("agent-1", ["echo", "second"]);

      // create should only be called once
      expect(mockManager.create).toHaveBeenCalledTimes(1);
      // exec should be called twice
      expect(mockManager.exec).toHaveBeenCalledTimes(2);
    });

    it("restarts stopped container", async () => {
      // First execution creates the container
      await executor.execute("agent-1", ["echo", "first"]);

      // Container is now stopped
      vi.mocked(mockManager.status).mockResolvedValueOnce({
        id: "container-123",
        name: "isotopes-sandbox-agent-1",
        status: "exited",
        image: "isotopes-sandbox:latest",
        createdAt: new Date(),
      });

      // Second execution should restart
      await executor.execute("agent-1", ["echo", "second"]);

      // start should be called twice (once on create, once on restart)
      expect(mockManager.start).toHaveBeenCalledTimes(2);
      // create should still only be called once
      expect(mockManager.create).toHaveBeenCalledTimes(1);
    });

    it("recreates container when restart fails", async () => {
      // First execution creates the container
      await executor.execute("agent-1", ["echo", "first"]);

      // Container is exited and can't restart
      vi.mocked(mockManager.status).mockResolvedValueOnce({
        id: "container-123",
        name: "isotopes-sandbox-agent-1",
        status: "exited",
        image: "isotopes-sandbox:latest",
        createdAt: new Date(),
      });
      vi.mocked(mockManager.start).mockRejectedValueOnce(
        new Error("Cannot restart"),
      );

      // Should remove old and create new
      const newContainer: ContainerInfo = {
        id: "container-456",
        name: "isotopes-sandbox-agent-1",
        status: "created",
        image: "isotopes-sandbox:latest",
        createdAt: new Date(),
      };
      vi.mocked(mockManager.create).mockResolvedValueOnce(newContainer);

      await executor.execute("agent-1", ["echo", "second"]);

      expect(mockManager.remove).toHaveBeenCalledWith("container-123", true);
      expect(mockManager.create).toHaveBeenCalledTimes(2);
    });

    it("uses /tmp as default workspace when none specified", async () => {
      await executor.execute("agent-1", ["ls"]);

      expect(mockManager.create).toHaveBeenCalledWith(
        "isotopes-sandbox-agent-1",
        "/tmp",
        "rw",
        [],
      );
    });

    it("passes mounts from defaultConfig to ContainerManager.create", async () => {
      await executor.execute("agent-1", ["ls"], { workspacePath: "/ws" });

      expect(mockManager.create).toHaveBeenCalledWith(
        "isotopes-sandbox-agent-1",
        "/ws",
        "rw",
        [],
      );
    });

    it("handles execution timeout", async () => {
      // Make exec hang indefinitely
      vi.mocked(mockManager.exec).mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      await expect(
        executor.execute("agent-1", ["sleep", "infinity"], { timeout: 50 }),
      ).rejects.toThrow("Sandbox execution timed out after 50ms");
    });
  });

  describe("buildExecArgv", () => {
    it("ensures container then returns docker exec argv", async () => {
      const argv = await executor.buildExecArgv("agent-1", ["sh", "-c", "echo hi"], {
        workspacePath: "/ws",
      });

      expect(mockManager.create).toHaveBeenCalledWith(
        "isotopes-sandbox-agent-1",
        "/ws",
        "rw",
        [],
      );
      expect(mockManager.start).toHaveBeenCalled();
      expect(mockManager.buildExecArgv).toHaveBeenCalledWith("container-123", [
        "sh", "-c", "echo hi",
      ]);
      expect(argv).toEqual(["docker", "exec", "-i", "container-123", "sh", "-c", "echo hi"]);
    });

    it("reuses an existing container", async () => {
      await executor.execute("agent-1", ["echo", "first"]);
      await executor.buildExecArgv("agent-1", ["sh", "-c", "echo bg"]);

      expect(mockManager.create).toHaveBeenCalledTimes(1);
      expect(mockManager.buildExecArgv).toHaveBeenCalledTimes(1);
    });
  });

  describe("shouldExecuteInSandbox", () => {
    it("returns true when default config is enabled", () => {
      expect(executor.shouldExecuteInSandbox("agent-1")).toBe(true);
    });

    it("returns false when default config is disabled", () => {
      const offExecutor = new SandboxExecutor(mockManager, { enabled: false });
      expect(offExecutor.shouldExecuteInSandbox("agent-1")).toBe(false);
    });

    it("uses agent-level config override when provided", () => {
      const agentOverride: SandboxConfig = { enabled: false };
      expect(executor.shouldExecuteInSandbox("agent-1", agentOverride)).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("stops and removes a specific agent's container", async () => {
      // Create a container first
      await executor.execute("agent-1", ["echo", "hello"]);

      await executor.cleanup("agent-1");

      expect(mockManager.stop).toHaveBeenCalledWith("container-123", 5);
      expect(mockManager.remove).toHaveBeenCalledWith("container-123", true);
    });

    it("does nothing when agent has no container", async () => {
      await executor.cleanup("nonexistent");

      expect(mockManager.stop).not.toHaveBeenCalled();
      expect(mockManager.remove).not.toHaveBeenCalled();
    });

    it("cleans up all containers when no agentId provided", async () => {
      // Create containers for two agents
      vi.mocked(mockManager.create)
        .mockResolvedValueOnce({
          id: "container-a",
          name: "isotopes-sandbox-agent-a",
          status: "created",
          image: "isotopes-sandbox:latest",
          createdAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: "container-b",
          name: "isotopes-sandbox-agent-b",
          status: "created",
          image: "isotopes-sandbox:latest",
          createdAt: new Date(),
        });

      vi.mocked(mockManager.status)
        .mockResolvedValueOnce({
          id: "container-a",
          name: "isotopes-sandbox-agent-a",
          status: "running",
          image: "isotopes-sandbox:latest",
          createdAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: "container-b",
          name: "isotopes-sandbox-agent-b",
          status: "running",
          image: "isotopes-sandbox:latest",
          createdAt: new Date(),
        });

      await executor.execute("agent-a", ["echo", "a"]);
      await executor.execute("agent-b", ["echo", "b"]);

      await executor.cleanup();
    });

    it("swallows errors during cleanup", async () => {
      await executor.execute("agent-1", ["echo", "hello"]);

      vi.mocked(mockManager.stop).mockRejectedValueOnce(
        new Error("Already stopped"),
      );
      vi.mocked(mockManager.remove).mockRejectedValueOnce(
        new Error("Already removed"),
      );

      // Should not throw
      await expect(executor.cleanup("agent-1")).resolves.toBeUndefined();
    });
  });
});
