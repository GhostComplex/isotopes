// src/iteration/pipeline.ts — Iteration pipeline
// Orchestrates Planner → Executor → Validator → Reporter into a single-step
// pipeline that produces a PR for each iteration.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../core/logger.js";
import type { IterationPlanner } from "./planner.js";
import type { IterationExecutor, StepResult } from "./executor.js";
import type { IterationReporter } from "./reporter.js";
import type { IterationStep } from "./types.js";

const log = createLogger("iteration:pipeline");
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineResult {
  skipped: boolean;
  skipReason?: "no_steps" | "pending_pr";
  pendingPR?: { url: string; number: number };
  step?: IterationStep;
  executionResult?: StepResult;
  validation?: { success: boolean; output?: string };
  pr?: { url: string; number: number };
  error?: string;
}

export interface PipelineOptions {
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class IterationPipeline {
  constructor(
    private planner: IterationPlanner,
    private executor: IterationExecutor,
    private reporter: IterationReporter,
    private repoPath: string,
  ) {}

  async runSingleStep(options: PipelineOptions = {}): Promise<PipelineResult> {
    // 0. Check for open iter/* PR
    const pendingPR = await this.checkPendingIterPR();
    if (pendingPR) {
      log.info(`Skipping: pending iteration PR #${pendingPR.number}`);
      return { skipped: true, skipReason: "pending_pr", pendingPR };
    }

    // 1. Analyze + generate plan from top opportunity
    const analysis = await this.planner.analyze();
    if (analysis.opportunities.length === 0) {
      log.info("No improvement opportunities found");
      return { skipped: true, skipReason: "no_steps" };
    }

    const planResult = this.planner.generatePlan(analysis.opportunities[0]);
    if (!planResult.success || !planResult.plan || planResult.plan.steps.length === 0) {
      log.info("Plan generation produced no steps");
      return { skipped: true, skipReason: "no_steps" };
    }

    // 2. Take first step only
    const step = planResult.plan.steps[0];
    log.info(`Selected step: ${step.description}`);

    if (options.dryRun) {
      return { skipped: false, step };
    }

    // 3. Create branch
    const branchName = `iter/${Date.now()}-${slugify(step.description)}`;
    await this.git("checkout", "-b", branchName);

    try {
      // 4. Execute step
      const executionResult = await this.executor.executeStep(step);
      if (!executionResult.success) {
        log.warn("Step execution failed, rolling back branch");
        await this.git("checkout", "main");
        await this.gitSafe("branch", "-D", branchName);
        return {
          skipped: false,
          step,
          executionResult,
          error: `Execution failed: ${executionResult.error?.message ?? "unknown"}`,
        };
      }

      // 5. Validate (tsc + vitest)
      const validation = await this.runValidation();
      if (!validation.success) {
        log.warn("Validation failed, rolling back branch");
        await this.git("checkout", "main");
        await this.gitSafe("branch", "-D", branchName);
        return {
          skipped: false,
          step,
          executionResult,
          validation,
          error: `Validation failed: ${validation.output ?? "unknown"}`,
        };
      }

      // 6. Selective git add + commit + push
      const filesToAdd = this.getAffectedFiles(step);
      for (const file of filesToAdd) {
        await this.gitSafe("add", file);
      }

      // Also add any modified tracked files (git diff --name-only)
      const { stdout: diffOutput } = await this.execInRepo("git", [
        "diff",
        "--name-only",
      ]);
      const changedFiles = diffOutput
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
      for (const file of changedFiles) {
        await this.gitSafe("add", file);
      }

      await this.git("commit", "-m", `feat(iteration): ${step.description}`);
      await this.git("push", "origin", branchName);

      // 7. Create PR
      const pr = await this.createPR(step, branchName);

      // 8. Return to main
      await this.git("checkout", "main");

      log.info(`Pipeline complete: PR #${pr.number} created`);
      return { skipped: false, step, executionResult, validation, pr };
    } catch (error) {
      // Rollback on any unexpected error
      await this.gitSafe("checkout", "main");
      await this.gitSafe("branch", "-D", branchName);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async checkPendingIterPR(): Promise<{ url: string; number: number } | null> {
    try {
      const { stdout } = await this.execInRepo("gh", [
        "pr",
        "list",
        "--search",
        "head:iter/",
        "--state",
        "open",
        "--json",
        "number,url",
        "--limit",
        "1",
      ]);

      const prs = JSON.parse(stdout || "[]") as Array<{
        number: number;
        url: string;
      }>;
      if (prs.length > 0) {
        return { url: prs[0].url, number: prs[0].number };
      }
      return null;
    } catch (err) {
      log.warn(
        `Failed to check pending PRs: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private getAffectedFiles(step: IterationStep): string[] {
    const files = [step.target];
    // IterationStep doesn't have affectedFiles yet, but guard for future additions
    const extra = (step as unknown as Record<string, unknown>).affectedFiles;
    if (Array.isArray(extra)) {
      files.push(...(extra as string[]));
    }
    return files;
  }

  private async runValidation(): Promise<{ success: boolean; output?: string }> {
    // tsc --noEmit
    try {
      await this.execInRepo("npx", ["tsc", "--noEmit"]);
    } catch (err) {
      const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
      return { success: false, output: `tsc failed: ${msg}` };
    }

    // vitest run
    try {
      await this.execInRepo("npx", ["vitest", "run", "--reporter=verbose"]);
    } catch (err) {
      const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
      return { success: false, output: `vitest failed: ${msg}` };
    }

    return { success: true };
  }

  private async createPR(
    step: IterationStep,
    branch: string,
  ): Promise<{ url: string; number: number }> {
    const title = `feat(iteration): ${step.description}`;
    const body = [
      "## Automated Iteration",
      "",
      `**Step:** ${step.name}`,
      `**Action:** ${step.action}`,
      `**Target:** ${step.target}`,
      "",
      `> ${step.description}`,
      "",
      "---",
      `Branch: \`${branch}\``,
      "Generated by IterationPipeline",
    ].join("\n");

    const { stdout } = await this.execInRepo("gh", [
      "pr",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--head",
      branch,
      "--base",
      "main",
      "--json",
      "number,url",
    ]);

    const pr = JSON.parse(stdout) as { number: number; url: string };
    return { url: pr.url, number: pr.number };
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await this.execInRepo("git", args);
    return stdout;
  }

  private async gitSafe(...args: string[]): Promise<string> {
    try {
      return await this.git(...args);
    } catch {
      return "";
    }
  }

  private execInRepo(
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(cmd, args, { cwd: this.repoPath });
  }
}
