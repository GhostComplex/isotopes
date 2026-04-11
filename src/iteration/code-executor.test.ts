// src/iteration/code-executor.test.ts — Unit tests for CodeExecutor

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodeExecutor, verifyChanges, createBackup, restoreFromBackup } from "./code-executor.js";
import type { IterationStep } from "./types.js";
import type { AcpxBackend } from "../subagent/acpx-backend.js";
import type { AcpxEvent, AcpxResult } from "../subagent/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestStep(overrides: Partial<IterationStep> = {}): IterationStep {
  return {
    id: "test-step-1",
    name: "Test Step",
    description: "A test step for code execution",
    action: "modify",
    target: "src/test.ts",
    dependencies: [],
    status: "pending",
    ...overrides,
  };
}

function createMockSubagent(overrides: Partial<AcpxResult> = {}): AcpxBackend {
  const result: AcpxResult = {
    success: true,
    output: "Code changes applied successfully",
    events: [],
    exitCode: 0,
    ...overrides,
  };

  // Create an async generator that yields no events
  async function* emptyGenerator(): AsyncGenerator<AcpxEvent> {
    // No events yielded — collectResult will use the returned result
  }

  return {
    spawn: vi.fn().mockReturnValue(emptyGenerator()),
    cancel: vi.fn().mockReturnValue(true),
    isRunning: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn(),
    get activeCount() {
      return 0;
    },
    workspacesKey: "/tmp",
    validateCwd: vi.fn(),
    validateAgent: vi.fn(),
    buildArgs: vi.fn().mockReturnValue([]),
    // Store the result so tests can reference it
    _mockResult: result,
  } as unknown as AcpxBackend;
}

// Mock child_process.spawn for verifyChanges tests
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

// We need to also mock collectResult since the mock generator won't produce real events
vi.mock("../subagent/acpx-backend.js", async () => {
  const actual =
    await vi.importActual<typeof import("../subagent/acpx-backend.js")>(
      "../subagent/acpx-backend.js",
    );
  return {
    ...actual,
    collectResult: vi.fn(),
  };
});

import { spawn as mockSpawn } from "node:child_process";
import { collectResult } from "../subagent/acpx-backend.js";
import { EventEmitter } from "node:events";

const mockedCollectResult = vi.mocked(collectResult);
const mockedSpawn = vi.mocked(mockSpawn);

/** Create a fake child process factory. Returns a function that creates
 *  the process when called (for use with mockImplementation). */
function fakeSpawnImpl(exitCode: number, stdout = "", stderr = "") {
  return () => {
    const proc = new EventEmitter();
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    Object.defineProperty(proc, "stdout", { value: stdoutEmitter, writable: false });
    Object.defineProperty(proc, "stderr", { value: stderrEmitter, writable: false });
    (proc as unknown as Record<string, unknown>).kill = vi.fn();

    process.nextTick(() => {
      if (stdout) stdoutEmitter.emit("data", Buffer.from(stdout));
      if (stderr) stderrEmitter.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    });

    return proc;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyChanges", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it("returns passed when both tsc and vitest succeed", async () => {
    // First call is tsc, second is vitest
    mockedSpawn
      .mockImplementationOnce(fakeSpawnImpl(0, "tsc ok") as never)
      .mockImplementationOnce(fakeSpawnImpl(0, "vitest ok") as never);

    const result = await verifyChanges("/fake/project");

    expect(result.passed).toBe(true);
    expect(result.tsc.success).toBe(true);
    expect(result.vitest.success).toBe(true);
  });

  it("skips vitest when tsc fails", async () => {
    mockedSpawn.mockImplementationOnce(
      fakeSpawnImpl(1, "", "tsc error: type mismatch") as never,
    );

    const result = await verifyChanges("/fake/project");

    expect(result.passed).toBe(false);
    expect(result.tsc.success).toBe(false);
    expect(result.tsc.stderr).toContain("tsc error");
    expect(result.vitest.success).toBe(false);
    expect(result.vitest.stderr).toContain("Skipped due to tsc failure");
    // spawn should only be called once (for tsc)
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("returns failed when vitest fails", async () => {
    mockedSpawn
      .mockImplementationOnce(fakeSpawnImpl(0, "tsc ok") as never)
      .mockImplementationOnce(fakeSpawnImpl(1, "", "test failed: expect(1).toBe(2)") as never);

    const result = await verifyChanges("/fake/project");

    expect(result.passed).toBe(false);
    expect(result.tsc.success).toBe(true);
    expect(result.vitest.success).toBe(false);
    expect(result.vitest.stderr).toContain("test failed");
  });

  it("passes test pattern to vitest", async () => {
    mockedSpawn
      .mockImplementationOnce(fakeSpawnImpl(0) as never)
      .mockImplementationOnce(fakeSpawnImpl(0) as never);

    await verifyChanges("/fake/project", "src/foo.test.ts");

    // Second call should be vitest with the pattern
    const vitestCall = mockedSpawn.mock.calls[1];
    expect(vitestCall[1]).toContain("src/foo.test.ts");
  });
});

describe("createBackup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "isotopes-backup-"));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("creates a .bak copy of the file", async () => {
    const filePath = path.join(tempDir, "file.ts");
    await fsPromises.writeFile(filePath, "original content");

    const backupPath = createBackup(filePath);

    expect(backupPath).toBe(`${filePath}.bak`);
    expect(fs.existsSync(backupPath!)).toBe(true);
    expect(fs.readFileSync(backupPath!, "utf-8")).toBe("original content");
  });

  it("returns undefined if file does not exist", () => {
    const result = createBackup(path.join(tempDir, "nonexistent.ts"));
    expect(result).toBeUndefined();
  });
});

describe("restoreFromBackup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "isotopes-restore-"));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("restores original file and removes backup", async () => {
    const filePath = path.join(tempDir, "file.ts");
    const backupPath = `${filePath}.bak`;
    await fsPromises.writeFile(filePath, "modified content");
    await fsPromises.writeFile(backupPath, "original content");

    const result = restoreFromBackup(backupPath);

    expect(result).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original content");
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("returns false if backup does not exist", () => {
    const result = restoreFromBackup(path.join(tempDir, "nonexistent.ts.bak"));
    expect(result).toBe(false);
  });
});

describe("CodeExecutor", () => {
  let tempDir: string;
  let mockSubagent: AcpxBackend;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "isotopes-code-exec-"));
    mockSubagent = createMockSubagent();
    mockedCollectResult.mockResolvedValue({
      success: true,
      output: "Changes applied",
      events: [],
      exitCode: 0,
    });
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createExecutor(overrides: { verify?: boolean } = {}) {
    return new CodeExecutor({
      projectRoot: tempDir,
      subagent: mockSubagent,
      verify: overrides.verify ?? false, // Disable verification by default in tests
    });
  }

  describe("executeModify", () => {
    it("succeeds when file exists and subagent succeeds", async () => {
      const srcDir = path.join(tempDir, "src");
      await fsPromises.mkdir(srcDir, { recursive: true });
      await fsPromises.writeFile(path.join(srcDir, "test.ts"), "original");

      const executor = createExecutor();
      const step = createTestStep({ target: "src/test.ts" });

      const result = await executor.executeModify(step);

      expect(result.success).toBe(true);
      expect(result.stepResult.status).toBe("completed");
      expect(mockSubagent.spawn).toHaveBeenCalledTimes(1);
    });

    it("fails when file does not exist", async () => {
      const executor = createExecutor();
      const step = createTestStep({ target: "src/nonexistent.ts" });

      const result = await executor.executeModify(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.status).toBe("failed");
      expect(result.stepResult.error).toContain("does not exist");
      expect(mockSubagent.spawn).not.toHaveBeenCalled();
    });

    it("rolls back when subagent fails", async () => {
      const filePath = path.join(tempDir, "src", "test.ts");
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, "original content");

      mockedCollectResult.mockResolvedValue({
        success: false,
        error: "Subagent crashed",
        events: [],
        exitCode: 1,
      });

      const executor = createExecutor();
      const step = createTestStep({ target: "src/test.ts" });

      const result = await executor.executeModify(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.error).toContain("Subagent failed");
      // Backup should have been restored (original content still there)
      expect(fs.readFileSync(filePath, "utf-8")).toBe("original content");
    });

    it("rolls back when verification fails", async () => {
      const filePath = path.join(tempDir, "src", "test.ts");
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, "original content");

      // Subagent succeeds
      mockedCollectResult.mockResolvedValue({
        success: true,
        output: "Modified",
        events: [],
        exitCode: 0,
      });

      // tsc fails during verification
      mockedSpawn.mockImplementationOnce(fakeSpawnImpl(1, "", "Type error") as never);

      const executor = createExecutor({ verify: true });
      const step = createTestStep({ target: "src/test.ts" });

      const result = await executor.executeModify(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.error).toContain("Verification failed");
      expect(result.verification).toBeDefined();
      expect(result.verification!.passed).toBe(false);
    });

    it("cleans up backup on success", async () => {
      const filePath = path.join(tempDir, "src", "test.ts");
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, "content");

      const executor = createExecutor();
      const step = createTestStep({ target: "src/test.ts" });

      await executor.executeModify(step);

      expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    });
  });

  describe("executeCreate", () => {
    it("succeeds when file is created by subagent", async () => {
      // Make the subagent "create" the file by having collectResult succeed
      // and then manually creating the file to simulate subagent action
      mockedCollectResult.mockImplementation(async () => {
        // Simulate the subagent creating the file
        const targetPath = path.join(tempDir, "src", "new-file.ts");
        await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
        await fsPromises.writeFile(targetPath, "new content");
        return { success: true, output: "Created file", events: [], exitCode: 0 };
      });

      const executor = createExecutor();
      const step = createTestStep({ action: "create", target: "src/new-file.ts" });

      const result = await executor.executeCreate(step);

      expect(result.success).toBe(true);
      expect(result.stepResult.status).toBe("completed");
    });

    it("fails when file already exists", async () => {
      const srcDir = path.join(tempDir, "src");
      await fsPromises.mkdir(srcDir, { recursive: true });
      await fsPromises.writeFile(path.join(srcDir, "existing.ts"), "existing");

      const executor = createExecutor();
      const step = createTestStep({ action: "create", target: "src/existing.ts" });

      const result = await executor.executeCreate(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.error).toContain("already exists");
      expect(mockSubagent.spawn).not.toHaveBeenCalled();
    });

    it("fails when subagent succeeds but file is not created", async () => {
      mockedCollectResult.mockResolvedValue({
        success: true,
        output: "Done",
        events: [],
        exitCode: 0,
      });

      const executor = createExecutor();
      const step = createTestStep({ action: "create", target: "src/missing.ts" });

      const result = await executor.executeCreate(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.error).toContain("not created");
    });

    it("cleans up partial file on subagent failure", async () => {
      const targetPath = path.join(tempDir, "src", "partial.ts");

      mockedCollectResult.mockImplementation(async () => {
        // Simulate subagent creating a partial file then failing
        await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
        await fsPromises.writeFile(targetPath, "partial");
        return { success: false, error: "Failed midway", events: [], exitCode: 1 };
      });

      const executor = createExecutor();
      const step = createTestStep({ action: "create", target: "src/partial.ts" });

      const result = await executor.executeCreate(step);

      expect(result.success).toBe(false);
      expect(fs.existsSync(targetPath)).toBe(false);
    });

    it("deletes created file on verification failure", async () => {
      const targetPath = path.join(tempDir, "src", "bad-types.ts");

      mockedCollectResult.mockImplementation(async () => {
        await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
        await fsPromises.writeFile(targetPath, "bad types");
        return { success: true, output: "Created", events: [], exitCode: 0 };
      });

      // tsc fails
      mockedSpawn.mockImplementationOnce(fakeSpawnImpl(1, "", "Type error") as never);

      const executor = createExecutor({ verify: true });
      const step = createTestStep({ action: "create", target: "src/bad-types.ts" });

      const result = await executor.executeCreate(step);

      expect(result.success).toBe(false);
      expect(result.verification!.passed).toBe(false);
      expect(fs.existsSync(targetPath)).toBe(false);
    });
  });

  describe("executeDelete", () => {
    it("deletes an existing file", async () => {
      const filePath = path.join(tempDir, "to-delete.ts");
      await fsPromises.writeFile(filePath, "delete me");

      const executor = createExecutor();
      const step = createTestStep({ action: "delete", target: "to-delete.ts" });

      const result = await executor.executeDelete(step);

      expect(result.success).toBe(true);
      expect(result.stepResult.status).toBe("completed");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("fails when file does not exist", async () => {
      const executor = createExecutor();
      const step = createTestStep({ action: "delete", target: "nonexistent.ts" });

      const result = await executor.executeDelete(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.error).toContain("does not exist");
    });

    it("restores file on verification failure", async () => {
      const filePath = path.join(tempDir, "important.ts");
      await fsPromises.writeFile(filePath, "important content");

      // tsc fails
      mockedSpawn.mockImplementationOnce(fakeSpawnImpl(1, "", "Missing import") as never);

      const executor = createExecutor({ verify: true });
      const step = createTestStep({ action: "delete", target: "important.ts" });

      const result = await executor.executeDelete(step);

      expect(result.success).toBe(false);
      expect(result.verification!.passed).toBe(false);
      // File should be restored
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("important content");
    });

    it("cleans up backup on success", async () => {
      const filePath = path.join(tempDir, "cleanup.ts");
      await fsPromises.writeFile(filePath, "content");

      const executor = createExecutor();
      const step = createTestStep({ action: "delete", target: "cleanup.ts" });

      await executor.executeDelete(step);

      expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    });
  });

  describe("subagent integration", () => {
    it("passes correct spawn options to subagent", async () => {
      const filePath = path.join(tempDir, "src", "test.ts");
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, "content");

      const executor = new CodeExecutor({
        projectRoot: tempDir,
        subagent: mockSubagent,
        verify: false,
        model: "claude-sonnet-4-20250514",
        maxTurns: 10,
        timeout: 120,
      });

      const step = createTestStep({ target: "src/test.ts" });
      await executor.executeModify(step);

      expect(mockSubagent.spawn).toHaveBeenCalledTimes(1);
      const spawnCall = vi.mocked(mockSubagent.spawn).mock.calls[0];
      const options = spawnCall[1];
      expect(options.agent).toBe("claude");
      expect(options.cwd).toBe(tempDir);
      expect(options.model).toBe("claude-sonnet-4-20250514");
      expect(options.maxTurns).toBe(10);
      expect(options.timeout).toBe(120);
      expect(options.permissionMode).toBe("allowlist");
      expect(options.allowedTools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    });

    it("handles subagent spawn exception", async () => {
      const filePath = path.join(tempDir, "src", "test.ts");
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, "content");

      vi.mocked(mockSubagent.spawn).mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const executor = createExecutor();
      const step = createTestStep({ target: "src/test.ts" });

      const result = await executor.executeModify(step);

      expect(result.success).toBe(false);
      expect(result.stepResult.error).toContain("Subagent failed");
    });
  });
});
