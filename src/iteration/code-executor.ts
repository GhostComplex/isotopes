// src/iteration/code-executor.ts — Real code execution via subagent with verification
// Executes iteration steps using Claude subagent and validates results with tsc + vitest.

import { spawn } from "node:child_process";
import { existsSync, copyFileSync, unlinkSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createLogger } from "../core/logger.js";
import { SubagentBackend, collectResult } from "../subagent/backend.js";
import type { SubagentResult } from "../subagent/types.js";
import type { IterationStep } from "./types.js";

const log = createLogger("iteration:code-executor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for CodeExecutor */
export interface CodeExecutorConfig {
  /** Project root directory (where package.json lives) */
  projectRoot: string;
  /** Subagent backend instance */
  subagent: SubagentBackend;
  /** Whether to run verification after each step. Default: true */
  verify?: boolean;
  /** Subagent model to use. Default: inherited from backend */
  model?: string;
  /** Maximum turns for subagent. Default: 20 */
  maxTurns?: number;
  /** Timeout in seconds for subagent. Default: 300 (5 min) */
  timeout?: number;
}

/** Lightweight result shape returned by CodeExecutor methods */
interface CodeStepResult {
  status: "completed" | "failed";
  error?: string;
  output?: string;
}

/** Result of code execution with verification */
export interface CodeExecutionResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** Step result for the iteration system */
  stepResult: CodeStepResult;
  /** Subagent output */
  subagentOutput?: string;
  /** Verification results */
  verification?: VerificationResult;
  /** Error message if failed */
  error?: string;
  /** Path to backup file if created */
  backupPath?: string;
}

/** Result of verification (tsc + vitest) */
export interface VerificationResult {
  /** Whether all checks passed */
  passed: boolean;
  /** TypeScript compilation result */
  tsc: CommandResult;
  /** Test result */
  vitest: CommandResult;
}

/** Result of running a shell command */
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Shell command execution
// ---------------------------------------------------------------------------

/**
 * Run a shell command and capture output.
 */
async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 60_000,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const proc = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin`,
        // Ensure non-interactive mode for vitest
        CI: "true",
      },
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        success: code === 0 && !killed,
        stdout,
        stderr,
        exitCode: killed ? -1 : (code ?? 1),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        success: false,
        stdout,
        stderr: stderr + "\n" + err.message,
        exitCode: -1,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Run TypeScript compilation check.
 */
async function runTsc(projectRoot: string): Promise<CommandResult> {
  log.debug("Running tsc --noEmit");
  return runCommand("npx", ["tsc", "--noEmit"], projectRoot);
}

/**
 * Run vitest in run mode (non-watch).
 */
async function runVitest(projectRoot: string, testPattern?: string): Promise<CommandResult> {
  const args = ["vitest", "run", "--reporter=verbose"];
  if (testPattern) {
    args.push(testPattern);
  }
  log.debug("Running vitest", { args });
  return runCommand("npx", args, projectRoot, 120_000); // 2 min timeout for tests
}

/**
 * Verify code changes by running tsc and vitest.
 */
export async function verifyChanges(
  projectRoot: string,
  relatedTestPattern?: string,
): Promise<VerificationResult> {
  log.info("Verifying changes with tsc + vitest");

  const tsc = await runTsc(projectRoot);
  if (!tsc.success) {
    log.warn("TypeScript compilation failed", { stderr: tsc.stderr.slice(0, 500) });
    return {
      passed: false,
      tsc,
      vitest: { success: false, stdout: "", stderr: "Skipped due to tsc failure", exitCode: -1 },
    };
  }

  log.debug("tsc passed");

  const vitest = await runVitest(projectRoot, relatedTestPattern);
  if (!vitest.success) {
    log.warn("Tests failed", { stderr: vitest.stderr.slice(0, 500) });
  } else {
    log.debug("vitest passed");
  }

  return {
    passed: tsc.success && vitest.success,
    tsc,
    vitest,
  };
}

// ---------------------------------------------------------------------------
// Backup and rollback
// ---------------------------------------------------------------------------

/**
 * Create a backup of a file.
 * @returns Backup path or undefined if file doesn't exist
 */
export function createBackup(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const backupPath = `${filePath}.bak`;
  copyFileSync(filePath, backupPath);
  log.debug(`Created backup: ${backupPath}`);
  return backupPath;
}

/**
 * Restore a file from backup.
 */
export function restoreFromBackup(backupPath: string): boolean {
  if (!existsSync(backupPath)) {
    log.warn(`Backup not found: ${backupPath}`);
    return false;
  }
  const originalPath = backupPath.replace(/\.bak$/, "");
  copyFileSync(backupPath, originalPath);
  unlinkSync(backupPath);
  log.info(`Restored from backup: ${originalPath}`);
  return true;
}

// ---------------------------------------------------------------------------
// CodeExecutor
// ---------------------------------------------------------------------------

/**
 * Executes iteration steps using Claude subagent with verification.
 */
export class CodeExecutor {
  private config: Required<CodeExecutorConfig>;

  constructor(config: CodeExecutorConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      subagent: config.subagent,
      verify: config.verify ?? true,
      model: config.model ?? "",
      maxTurns: config.maxTurns ?? 20,
      timeout: config.timeout ?? 300,
    };
  }

  /**
   * Execute a step that modifies an existing file.
   */
  async executeModify(step: IterationStep): Promise<CodeExecutionResult> {
    const targetPath = resolve(this.config.projectRoot, step.target);

    if (!existsSync(targetPath)) {
      return {
        success: false,
        stepResult: {
          status: "failed",
          error: `File does not exist: ${step.target}`,
        },
        error: `File does not exist: ${step.target}`,
      };
    }

    // Create backup before modification
    const backupPath = createBackup(targetPath);

    // Build prompt for subagent
    const prompt = this.buildModifyPrompt(step, targetPath);

    // Execute via subagent
    const subagentResult = await this.runSubagent(prompt);

    if (!subagentResult.success) {
      // Rollback on subagent failure
      if (backupPath) {
        restoreFromBackup(backupPath);
      }
      return {
        success: false,
        stepResult: {
          status: "failed",
          error: `Subagent failed: ${subagentResult.error}`,
        },
        subagentOutput: subagentResult.output,
        error: subagentResult.error,
        backupPath,
      };
    }

    // Verify changes if enabled
    if (this.config.verify) {
      const verification = await verifyChanges(this.config.projectRoot);

      if (!verification.passed) {
        // Rollback on verification failure
        if (backupPath) {
          restoreFromBackup(backupPath);
          log.info(`Rolled back ${step.target} due to verification failure`);
        }
        return {
          success: false,
          stepResult: {
            status: "failed",
            error: `Verification failed: ${this.formatVerificationError(verification)}`,
          },
          subagentOutput: subagentResult.output,
          verification,
          error: `Verification failed`,
          backupPath,
        };
      }
    }

    // Success - clean up backup
    if (backupPath && existsSync(backupPath)) {
      unlinkSync(backupPath);
      log.debug(`Cleaned up backup: ${backupPath}`);
    }

    return {
      success: true,
      stepResult: {
        status: "completed",
        output: subagentResult.output,
      },
      subagentOutput: subagentResult.output,
    };
  }

  /**
   * Execute a step that creates a new file.
   */
  async executeCreate(step: IterationStep): Promise<CodeExecutionResult> {
    const targetPath = resolve(this.config.projectRoot, step.target);

    // Ensure parent directory exists
    const parentDir = dirname(targetPath);
    await mkdir(parentDir, { recursive: true });

    // Check if file already exists (shouldn't for create)
    if (existsSync(targetPath)) {
      return {
        success: false,
        stepResult: {
          status: "failed",
          error: `File already exists: ${step.target}. Use 'modify' action instead.`,
        },
        error: `File already exists: ${step.target}`,
      };
    }

    // Build prompt for subagent
    const prompt = this.buildCreatePrompt(step, targetPath);

    // Execute via subagent
    const subagentResult = await this.runSubagent(prompt);

    if (!subagentResult.success) {
      // Clean up any partial file that might have been created
      if (existsSync(targetPath)) {
        unlinkSync(targetPath);
      }
      return {
        success: false,
        stepResult: {
          status: "failed",
          error: `Subagent failed: ${subagentResult.error}`,
        },
        subagentOutput: subagentResult.output,
        error: subagentResult.error,
      };
    }

    // Verify the file was created
    if (!existsSync(targetPath)) {
      return {
        success: false,
        stepResult: {
          status: "failed",
          error: `Subagent completed but file was not created: ${step.target}`,
        },
        subagentOutput: subagentResult.output,
        error: `File not created`,
      };
    }

    // Verify changes if enabled
    if (this.config.verify) {
      const verification = await verifyChanges(this.config.projectRoot);

      if (!verification.passed) {
        // Rollback: delete the created file
        unlinkSync(targetPath);
        log.info(`Deleted ${step.target} due to verification failure`);
        return {
          success: false,
          stepResult: {
            status: "failed",
            error: `Verification failed: ${this.formatVerificationError(verification)}`,
          },
          subagentOutput: subagentResult.output,
          verification,
          error: `Verification failed`,
        };
      }
    }

    return {
      success: true,
      stepResult: {
        status: "completed",
        output: subagentResult.output,
      },
      subagentOutput: subagentResult.output,
    };
  }

  /**
   * Execute a step that deletes a file.
   */
  async executeDelete(step: IterationStep): Promise<CodeExecutionResult> {
    const targetPath = resolve(this.config.projectRoot, step.target);

    if (!existsSync(targetPath)) {
      return {
        success: false,
        stepResult: {
          status: "failed",
          error: `File does not exist: ${step.target}`,
        },
        error: `File does not exist: ${step.target}`,
      };
    }

    // Create backup before deletion
    const backupPath = createBackup(targetPath);

    // Delete the file
    unlinkSync(targetPath);
    log.info(`Deleted: ${step.target}`);

    // Verify changes if enabled
    if (this.config.verify) {
      const verification = await verifyChanges(this.config.projectRoot);

      if (!verification.passed) {
        // Rollback: restore from backup
        if (backupPath) {
          restoreFromBackup(backupPath);
          log.info(`Restored ${step.target} due to verification failure`);
        }
        return {
          success: false,
          stepResult: {
            status: "failed",
            error: `Verification failed: ${this.formatVerificationError(verification)}`,
          },
          verification,
          error: `Verification failed`,
          backupPath,
        };
      }
    }

    // Success - clean up backup
    if (backupPath && existsSync(backupPath)) {
      unlinkSync(backupPath);
    }

    return {
      success: true,
      stepResult: {
        status: "completed",
      },
    };
  }

  /**
   * Build a prompt for modifying an existing file.
   */
  private buildModifyPrompt(step: IterationStep, targetPath: string): string {
    const currentContent = readFileSync(targetPath, "utf-8");

    return `You are modifying the file: ${step.target}

## Task
${step.description}

## Current File Content
\`\`\`
${currentContent}
\`\`\`

## Instructions
1. Read the current file content carefully
2. Make the necessary modifications to accomplish the task
3. Use the Edit or Write tool to save your changes
4. Ensure the code compiles (TypeScript) and tests pass

Do NOT add placeholder comments or TODO markers. Implement the actual functionality.`;
  }

  /**
   * Build a prompt for creating a new file.
   */
  private buildCreatePrompt(step: IterationStep, targetPath: string): string {
    return `You are creating a new file: ${step.target}

## Task
${step.description}

## Instructions
1. Create the file with complete, working implementation
2. Follow the project's existing code style and patterns
3. Include proper TypeScript types
4. Add JSDoc comments for public APIs
5. Use the Write tool to create the file

Do NOT add placeholder comments or TODO markers. Implement the actual functionality.

The file should be saved to: ${targetPath}`;
  }

  /**
   * Run subagent with the given prompt.
   */
  private async runSubagent(prompt: string): Promise<SubagentResult> {
    const taskId = `iteration-${Date.now()}`;

    log.info("Starting subagent for code execution", { taskId });

    try {
      const events = this.config.subagent.spawn(taskId, {
        agent: "claude",
        prompt,
        cwd: this.config.projectRoot,
        model: this.config.model || undefined,
        maxTurns: this.config.maxTurns,
        timeout: this.config.timeout,
        permissionMode: "allowlist",
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
      });

      return await collectResult(events);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Subagent execution failed", { taskId, error: errorMsg });
      return {
        success: false,
        error: errorMsg,
        events: [],
        exitCode: 1,
      };
    }
  }

  /**
   * Format verification error for display.
   */
  private formatVerificationError(verification: VerificationResult): string {
    const errors: string[] = [];

    if (!verification.tsc.success) {
      errors.push(`TypeScript: ${verification.tsc.stderr.slice(0, 200)}`);
    }
    if (!verification.vitest.success) {
      errors.push(`Tests: ${verification.vitest.stderr.slice(0, 200)}`);
    }

    return errors.join("; ");
  }
}
