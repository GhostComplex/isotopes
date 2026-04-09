// src/iteration/executor.test.ts — Unit tests for iteration executor

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { IterationExecutor, createExecutor } from "./executor.js";
import type { IterationPlan, IterationStep, StepAction } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestStep(overrides: Partial<IterationStep> = {}): IterationStep {
  return {
    id: "test-step-1",
    name: "Test Step",
    description: "A test step",
    action: "modify",
    target: "src/test.ts",
    dependencies: [],
    status: "pending",
    ...overrides,
  };
}

function createTestPlan(steps: IterationStep[]): IterationPlan {
  return {
    id: "test-plan-1",
    name: "Test Plan",
    description: "A test plan",
    steps,
    estimatedDuration: 15,
    priority: "medium",
    status: "planned",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IterationExecutor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-executor-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("creates executor with required options", () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });
      expect(executor).toBeInstanceOf(IterationExecutor);
    });

    it("accepts optional callbacks", () => {
      const onStepStart = vi.fn();
      const onStepComplete = vi.fn();
      const onStepError = vi.fn();

      const executor = new IterationExecutor({
        workspacePath: tempDir,
        dryRun: true,
        onStepStart,
        onStepComplete,
        onStepError,
      });

      expect(executor).toBeInstanceOf(IterationExecutor);
    });
  });

  describe("execute", () => {
    it("executes an empty plan successfully", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });
      const plan = createTestPlan([]);

      const result = await executor.execute(plan);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(0);
      expect(result.totalSteps).toBe(0);
      expect(result.plan.status).toBe("completed");
    });

    it("executes a single step plan", async () => {
      // Create source file for modify action
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "test.ts"), "// test file");

      const executor = new IterationExecutor({ workspacePath: tempDir });
      const step = createTestStep();
      const plan = createTestPlan([step]);

      const result = await executor.execute(plan);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(1);
      expect(result.totalSteps).toBe(1);
      expect(step.status).toBe("completed");
    });

    it("executes steps in order", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "file1.ts"), "// file 1");
      await fs.writeFile(path.join(srcDir, "file2.ts"), "// file 2");

      const executionOrder: string[] = [];
      const onStepStart = vi.fn((step: IterationStep) => {
        executionOrder.push(step.id);
      });

      const executor = new IterationExecutor({
        workspacePath: tempDir,
        onStepStart,
      });

      const steps = [
        createTestStep({ id: "step-1", target: "src/file1.ts" }),
        createTestStep({ id: "step-2", target: "src/file2.ts" }),
      ];
      const plan = createTestPlan(steps);

      await executor.execute(plan);

      expect(executionOrder).toEqual(["step-1", "step-2"]);
    });

    it("respects step dependencies", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "base.ts"), "// base");
      await fs.writeFile(path.join(srcDir, "derived.ts"), "// derived");

      const executor = new IterationExecutor({ workspacePath: tempDir });

      const steps = [
        createTestStep({ id: "step-1", name: "Base", target: "src/base.ts" }),
        createTestStep({
          id: "step-2",
          name: "Derived",
          target: "src/derived.ts",
          dependencies: ["step-1"],
        }),
      ];
      const plan = createTestPlan(steps);

      const result = await executor.execute(plan);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(2);
    });

    it("fails when dependencies are not met", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      // Step depends on non-existent step
      const steps = [
        createTestStep({
          id: "step-1",
          dependencies: ["non-existent"],
        }),
      ];
      const plan = createTestPlan(steps);

      const result = await executor.execute(plan);

      expect(result.success).toBe(false);
      expect(result.completedSteps).toBe(0);
      expect(steps[0].status).toBe("failed");
      expect(steps[0].error).toContain("Unmet dependencies");
    });

    it("stops on step failure", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const steps = [
        createTestStep({
          id: "step-1",
          action: "modify",
          target: "nonexistent.ts", // Will fail
        }),
        createTestStep({ id: "step-2" }),
      ];
      const plan = createTestPlan(steps);

      const result = await executor.execute(plan);

      expect(result.success).toBe(false);
      expect(result.completedSteps).toBe(0);
      expect(result.plan.status).toBe("failed");
      // Step 2 should not have been attempted
      expect(steps[1].status).toBe("pending");
    });

    it("calls onStepStart and onStepComplete callbacks", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "test.ts"), "// test");

      const onStepStart = vi.fn();
      const onStepComplete = vi.fn();

      const executor = new IterationExecutor({
        workspacePath: tempDir,
        onStepStart,
        onStepComplete,
      });

      const step = createTestStep();
      const plan = createTestPlan([step]);

      await executor.execute(plan);

      expect(onStepStart).toHaveBeenCalledWith(step);
      expect(onStepComplete).toHaveBeenCalledTimes(1);
      expect(onStepComplete.mock.calls[0][0]).toBe(step);
      expect(onStepComplete.mock.calls[0][1].success).toBe(true);
    });

    it("calls onStepError callback on failure", async () => {
      const onStepError = vi.fn();

      const executor = new IterationExecutor({
        workspacePath: tempDir,
        onStepError,
      });

      const step = createTestStep({
        action: "modify",
        target: "nonexistent.ts",
      });
      const plan = createTestPlan([step]);

      await executor.execute(plan);

      expect(onStepError).toHaveBeenCalled();
      expect(onStepError.mock.calls[0][0]).toBe(step);
      expect(onStepError.mock.calls[0][1]).toBeInstanceOf(Error);
    });

    it("updates plan status and timestamps", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });
      const plan = createTestPlan([]);
      const originalUpdatedAt = plan.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await executor.execute(plan);

      expect(plan.status).toBe("completed");
      expect(plan.updatedAt!.getTime()).toBeGreaterThan(originalUpdatedAt!.getTime());
    });

    it("reports total duration", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });
      const plan = createTestPlan([]);

      const result = await executor.execute(plan);

      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("executeStep", () => {
    it("returns result with duration", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "test.ts"), "// test");

      const executor = new IterationExecutor({ workspacePath: tempDir });
      const step = createTestStep();

      const result = await executor.executeStep(step);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("updates step status to in-progress", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "test.ts"), "// test");

      let statusDuringExecution: string | undefined;
      const onStepStart = vi.fn((step: IterationStep) => {
        statusDuringExecution = step.status;
      });

      const executor = new IterationExecutor({
        workspacePath: tempDir,
        onStepStart,
      });
      const step = createTestStep();

      await executor.executeStep(step);

      expect(statusDuringExecution).toBe("in-progress");
    });
  });

  describe("dry run mode", () => {
    it("does not execute actions in dry run mode", async () => {
      const executor = new IterationExecutor({
        workspacePath: tempDir,
        dryRun: true,
      });

      const step = createTestStep({
        action: "create",
        target: "src/new-file.ts",
      });
      const plan = createTestPlan([step]);

      const result = await executor.execute(plan);

      expect(result.success).toBe(true);
      expect(result.results.get(step.id)?.output).toContain("[DRY RUN]");

      // File should not be created
      await expect(fs.stat(path.join(tempDir, "src/new-file.ts"))).rejects.toThrow();
    });

    it("succeeds for all action types in dry run", async () => {
      const executor = new IterationExecutor({
        workspacePath: tempDir,
        dryRun: true,
      });

      const steps = [
        createTestStep({ id: "1", action: "create", target: "new.ts" }),
        createTestStep({ id: "2", action: "modify", target: "old.ts" }),
        createTestStep({ id: "3", action: "delete", target: "remove.ts" }),
        createTestStep({ id: "4", action: "test", target: "test.ts" }),
        createTestStep({ id: "5", action: "deploy", target: "deploy" }),
      ];
      const plan = createTestPlan(steps);

      const result = await executor.execute(plan);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(5);
    });
  });

  describe("create action", () => {
    it("creates a new file", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "create",
        target: "src/new-file.ts",
        name: "New File",
        description: "A new file",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Created");

      const content = await fs.readFile(path.join(tempDir, "src/new-file.ts"), "utf-8");
      expect(content).toContain("New File");
    });

    it("fails if file already exists", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/existing.ts"), "// existing");

      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "create",
        target: "src/existing.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("already exists");
    });

    it("creates parent directories", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "create",
        target: "deep/nested/path/file.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(true);
      const stat = await fs.stat(path.join(tempDir, "deep/nested/path/file.ts"));
      expect(stat.isFile()).toBe(true);
    });
  });

  describe("modify action", () => {
    it("succeeds for existing file", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/existing.ts"), "// existing");

      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "modify",
        target: "src/existing.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(true);
      expect(result.output).toContain("modify");
    });

    it("fails for non-existent file", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "modify",
        target: "src/nonexistent.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("not found");
    });

    it("handles paths with line numbers", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/file.ts"), "// file");

      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "modify",
        target: "src/file.ts:42",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(true);
    });
  });

  describe("delete action", () => {
    it("deletes an existing file", async () => {
      const filePath = path.join(tempDir, "to-delete.ts");
      await fs.writeFile(filePath, "// delete me");

      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "delete",
        target: "to-delete.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(true);
      await expect(fs.stat(filePath)).rejects.toThrow();
    });

    it("succeeds for non-existent file (idempotent)", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "delete",
        target: "already-gone.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(true);
      expect(result.output).toContain("already deleted");
    });
  });

  describe("test action", () => {
    it("runs npm test for general target", async () => {
      // We can't easily test actual npm test, so just verify structure
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "test",
        target: "tests/",
      });

      // This will fail because npm test won't work in temp dir
      // but we verify the action is handled
      const result = await executor.executeStep(step);

      // Expected to fail since no package.json
      expect(result.success).toBe(false);
    });
  });

  describe("deploy action", () => {
    it("runs npm run build", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      const step = createTestStep({
        action: "deploy",
        target: "production",
      });

      // This will fail because npm run build won't work in temp dir
      const result = await executor.executeStep(step);

      // Expected to fail since no package.json
      expect(result.success).toBe(false);
    });
  });

  describe("createExecutor", () => {
    it("creates executor instance", () => {
      const executor = createExecutor({ workspacePath: tempDir });
      expect(executor).toBeInstanceOf(IterationExecutor);
    });
  });

  describe("error handling", () => {
    it("catches and wraps exceptions", async () => {
      const executor = new IterationExecutor({ workspacePath: tempDir });

      // Create step with invalid action to trigger error path
      const step = createTestStep({
        action: "unknown" as StepAction,
        target: "test.ts",
      });

      const result = await executor.executeStep(step);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain("Unknown action");
    });
  });
});
