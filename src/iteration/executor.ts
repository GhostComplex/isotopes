// src/iteration/executor.ts — Iteration execution module
// Executes iteration plans step by step, respecting dependencies.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLogger } from "../core/logger.js";
import type { AcpxBackend } from "../subagent/acpx-backend.js";
import { CodeExecutor } from "./code-executor.js";
import type { IterationPlan, IterationStep } from "./types.js";

const log = createLogger("executor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the iteration executor. */
export interface ExecutorOptions {
  /** Path to the workspace directory */
  workspacePath: string;
  /** If true, simulates execution without making changes */
  dryRun?: boolean;
  /** Subagent backend for real code execution (optional) */
  subagent?: AcpxBackend;
  /** Whether to run verification (tsc + vitest) after each step. Default: true */
  verifySteps?: boolean;
  /** Subagent model override */
  subagentModel?: string;
  /** Callback when a step starts */
  onStepStart?: (_step: IterationStep) => void;
  /** Callback when a step completes */
  onStepComplete?: (_step: IterationStep, result: StepResult) => void;
  /** Callback when a step fails */
  onStepError?: (_step: IterationStep, error: Error) => void;
}

/** Result of executing a single step. */
export interface StepResult {
  /** Whether the step succeeded */
  success: boolean;
  /** Output from the step (if any) */
  output?: string;
  /** Error that occurred (if any) */
  error?: Error;
  /** Execution duration in milliseconds */
  duration: number;
}

/** Result of executing an entire plan. */
export interface ExecutionResult {
  /** The plan that was executed */
  plan: IterationPlan;
  /** Whether all steps succeeded */
  success: boolean;
  /** Number of steps completed successfully */
  completedSteps: number;
  /** Total number of steps in the plan */
  totalSteps: number;
  /** Results keyed by step ID */
  results: Map<string, StepResult>;
  /** Total execution duration in milliseconds */
  totalDuration: number;
}

// ---------------------------------------------------------------------------
// Executor implementation
// ---------------------------------------------------------------------------

/**
 * Iteration executor that runs plan steps in order, respecting dependencies.
 */
export class IterationExecutor {
  private readonly options: Required<Pick<ExecutorOptions, "workspacePath">> &
    Omit<ExecutorOptions, "workspacePath">;
  private readonly codeExecutor?: CodeExecutor;

  constructor(options: ExecutorOptions) {
    this.options = {
      workspacePath: options.workspacePath,
      dryRun: options.dryRun ?? false,
      subagent: options.subagent,
      verifySteps: options.verifySteps ?? true,
      subagentModel: options.subagentModel,
      onStepStart: options.onStepStart,
      onStepComplete: options.onStepComplete,
      onStepError: options.onStepError,
    };

    // Initialize CodeExecutor if subagent is provided
    if (options.subagent) {
      this.codeExecutor = new CodeExecutor({
        projectRoot: options.workspacePath,
        subagent: options.subagent,
        verify: options.verifySteps ?? true,
        model: options.subagentModel,
      });
    }
  }

  /**
   * Execute an entire iteration plan.
   * Steps are executed in order, respecting dependencies.
   */
  async execute(plan: IterationPlan): Promise<ExecutionResult> {
    const startTime = Date.now();
    const results = new Map<string, StepResult>();
    const completedSteps = new Set<string>();
    let allSucceeded = true;

    log.info(`Executing plan: ${plan.name} (${plan.steps.length} steps)`);

    // Update plan status
    plan.status = "in-progress";
    plan.updatedAt = new Date();

    for (const step of plan.steps) {
      // Validate dependencies before executing
      if (!this.validateDependencies(step, completedSteps)) {
        const error = new Error(
          `Unmet dependencies for step ${step.id}: ${step.dependencies.filter((d) => !completedSteps.has(d)).join(", ")}`,
        );
        const result: StepResult = {
          success: false,
          error,
          duration: 0,
        };
        results.set(step.id, result);
        step.status = "failed";
        step.error = error.message;
        allSucceeded = false;

        this.options.onStepError?.(step, error);
        log.warn(`Step ${step.id} skipped due to unmet dependencies`);

        // Continue to next step instead of aborting the entire plan
        continue;
      }

      // Execute the step
      const result = await this.executeStep(step);
      results.set(step.id, result);

      if (result.success) {
        completedSteps.add(step.id);
        step.status = "completed";
        step.output = result.output;
      } else {
        step.status = "failed";
        step.error = result.error?.message;
        allSucceeded = false;

        // Stop execution on failure
        log.error(`Step ${step.id} failed, aborting plan execution`);
        break;
      }
    }

    // Update plan status
    plan.status = allSucceeded ? "completed" : "failed";
    plan.updatedAt = new Date();

    const totalDuration = Date.now() - startTime;

    log.info(
      `Plan execution ${allSucceeded ? "completed" : "failed"}: ${completedSteps.size}/${plan.steps.length} steps in ${totalDuration}ms`,
    );

    return {
      plan,
      success: allSucceeded,
      completedSteps: completedSteps.size,
      totalSteps: plan.steps.length,
      results,
      totalDuration,
    };
  }

  /**
   * Execute a single step.
   */
  async executeStep(step: IterationStep): Promise<StepResult> {
    const startTime = Date.now();

    log.debug(`Executing step: ${step.name} (${step.action} -> ${step.target})`);

    // Update step status
    step.status = "in-progress";
    this.options.onStepStart?.(step);

    try {
      const result = await this.executeAction(step);
      const duration = Date.now() - startTime;

      const stepResult: StepResult = {
        success: result.success,
        output: result.output,
        error: result.error,
        duration,
      };

      if (result.success) {
        this.options.onStepComplete?.(step, stepResult);
        log.debug(`Step ${step.id} completed in ${duration}ms`);
      } else {
        this.options.onStepError?.(step, result.error ?? new Error("Unknown error"));
        log.warn(`Step ${step.id} failed after ${duration}ms`);
      }

      return stepResult;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const duration = Date.now() - startTime;

      this.options.onStepError?.(step, error);
      log.error(`Step ${step.id} threw exception:`, error);

      return {
        success: false,
        error,
        duration,
      };
    }
  }

  /**
   * Validate that all step dependencies have been completed.
   */
  private validateDependencies(
    step: IterationStep,
    completedSteps: Set<string>,
  ): boolean {
    return step.dependencies.every((depId) => completedSteps.has(depId));
  }

  /**
   * Execute the action for a step based on its action type.
   */
  private async executeAction(
    step: IterationStep,
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    if (this.options.dryRun) {
      log.info(`[DRY RUN] Would execute: ${step.action} on ${step.target}`);
      return {
        success: true,
        output: `[DRY RUN] ${step.action}: ${step.target}`,
      };
    }

    switch (step.action) {
      case "create":
        return this.executeCreate(step);
      case "modify":
        return this.executeModify(step);
      case "delete":
        return this.executeDelete(step);
      case "test":
        return this.executeTest(step);
      case "deploy":
        return this.executeDeploy(step);
      default:
        return {
          success: false,
          error: new Error(`Unknown action: ${step.action}`),
        };
    }
  }

  /**
   * Execute a create action - creates a new file.
   */
  private async executeCreate(
    step: IterationStep,
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    // Use CodeExecutor if available
    if (this.codeExecutor) {
      const result = await this.codeExecutor.executeCreate(step);
      return {
        success: result.success,
        output: result.stepResult.output,
        error: result.stepResult.error ? new Error(result.stepResult.error) : undefined,
      };
    }

    // Fallback: stub implementation for dry-run or no subagent
    const targetPath = this.resolvePath(step.target);

    try {
      // Check if file already exists
      try {
        await fs.stat(targetPath);
        return {
          success: false,
          error: new Error(`File already exists: ${step.target}`),
        };
      } catch {
        // File doesn't exist, which is what we want
      }

      // Create parent directory if needed
      const parentDir = path.dirname(targetPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Create file with placeholder content
      const content = `// ${step.name}\n// ${step.description}\n`;
      await fs.writeFile(targetPath, content, "utf-8");

      log.info(`Created file: ${step.target}`);
      return {
        success: true,
        output: `Created ${step.target}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Execute a modify action - modifies an existing file.
   */
  private async executeModify(
    step: IterationStep,
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    // Use CodeExecutor if available
    if (this.codeExecutor) {
      const result = await this.codeExecutor.executeModify(step);
      return {
        success: result.success,
        output: result.stepResult.output,
        error: result.stepResult.error ? new Error(result.stepResult.error) : undefined,
      };
    }

    // Fallback: stub implementation for no subagent
    const targetPath = this.resolvePath(step.target);

    try {
      // Check if file exists
      await fs.stat(targetPath);

      log.info(`Modify step registered for: ${step.target} (no subagent configured)`);
      return {
        success: true,
        output: `Ready to modify ${step.target}`,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          success: false,
          error: new Error(`File not found: ${step.target}`),
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Execute a delete action - removes a file.
   */
  private async executeDelete(
    step: IterationStep,
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    // Use CodeExecutor if available
    if (this.codeExecutor) {
      const result = await this.codeExecutor.executeDelete(step);
      return {
        success: result.success,
        output: result.stepResult.output,
        error: result.stepResult.error ? new Error(result.stepResult.error) : undefined,
      };
    }

    // Fallback: stub implementation for no subagent
    const targetPath = this.resolvePath(step.target);

    try {
      await fs.unlink(targetPath);
      log.info(`Deleted file: ${step.target}`);
      return {
        success: true,
        output: `Deleted ${step.target}`,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File already doesn't exist - consider this success
        return {
          success: true,
          output: `File already deleted: ${step.target}`,
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Execute a test action - runs tests.
   */
  private async executeTest(
    step: IterationStep,
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    // Determine test command based on target
    const target = step.target;
    const testCmd = "npm";

    // Determine test args based on target file type
    const getTestArgs = (): string[] => {
      if (target.endsWith(".test.ts") || target.endsWith(".test.js")) {
        return ["test", "--", target];
      } else if (target.endsWith(".ts") || target.endsWith(".js")) {
        // Convert source file to test file pattern
        const testFile = target.replace(/\.(ts|js)$/, ".test.$1");
        return ["test", "--", testFile];
      }
      return ["test"];
    };

    return this.runCommand(testCmd, getTestArgs());
  }

  /**
   * Execute a deploy action - runs deployment command.
   */
  private async executeDeploy(
    _step: IterationStep,
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    // Simple deploy command - in real usage this would be configurable
    return this.runCommand("npm", ["run", "build"]);
  }

  /**
   * Run a shell command and return the result.
   */
  private runCommand(
    command: string,
    args: string[],
  ): Promise<{ success: boolean; output?: string; error?: Error }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: this.options.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          error: err,
        });
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            output: stdout || undefined,
          });
        } else {
          resolve({
            success: false,
            output: stdout || undefined,
            error: new Error(stderr || `Command exited with code ${code}`),
          });
        }
      });
    });
  }

  /**
   * Resolve a target path relative to the workspace.
   */
  private resolvePath(target: string): string {
    // Remove line number suffix if present (e.g., "src/file.ts:42" -> "src/file.ts")
    const filePath = target.replace(/:\d+$/, "");

    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(this.options.workspacePath, filePath);
  }
}

/**
 * Create a new iteration executor instance.
 */
export function createExecutor(options: ExecutorOptions): IterationExecutor {
  return new IterationExecutor(options);
}
