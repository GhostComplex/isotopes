// src/iteration/pipeline.test.ts — Tests for IterationPipeline

import { describe, it, expect, vi, beforeEach } from "vitest";
import { IterationPipeline } from "./pipeline.js";
import type { IterationPlanner } from "./planner.js";
import type { IterationExecutor } from "./executor.js";
import type { IterationReporter } from "./reporter.js";
import type { IterationStep, AnalysisResult, PlanResult } from "./types.js";
import type { StepResult } from "./executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<IterationStep> = {}): IterationStep {
  return {
    id: "step-1",
    name: "Fix foo",
    description: "Fix the foo module",
    action: "modify",
    target: "src/foo.ts",
    dependencies: [],
    status: "pending",
    ...overrides,
  };
}

function makeAnalysis(
  opportunities: AnalysisResult["opportunities"] = [],
): AnalysisResult {
  return {
    opportunities,
    stats: {
      total: opportunities.length,
      bySource: { backlog: 0, todo: 0, issue: 0, analysis: 0 },
      byPriority: { low: 0, medium: 0, high: 0, critical: 0 },
    },
  };
}

function makePlanResult(step: IterationStep): PlanResult {
  return {
    success: true,
    plan: {
      id: "plan-1",
      name: "Test plan",
      description: "A test plan",
      steps: [step],
      estimatedDuration: 15,
      priority: "medium",
      status: "planned",
    },
  };
}

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    success: true,
    output: "done",
    duration: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPlanner(
  analysis: AnalysisResult = makeAnalysis(),
  planResult: PlanResult = { success: false },
): IterationPlanner {
  return {
    analyze: vi.fn().mockResolvedValue(analysis),
    generatePlan: vi.fn().mockReturnValue(planResult),
    generatePlans: vi.fn().mockReturnValue([]),
  } as unknown as IterationPlanner;
}

function createMockExecutor(
  stepResult: StepResult = makeStepResult(),
): IterationExecutor {
  return {
    execute: vi.fn(),
    executeStep: vi.fn().mockResolvedValue(stepResult),
  } as unknown as IterationExecutor;
}

function createMockReporter(): IterationReporter {
  return {
    generateReport: vi.fn().mockReturnValue("report"),
    generatePlanSummary: vi.fn().mockReturnValue("summary"),
    generateAnalysisReport: vi.fn().mockReturnValue("analysis"),
    formatStepResult: vi.fn().mockReturnValue("step"),
  } as unknown as IterationReporter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IterationPipeline", () => {
  let planner: ReturnType<typeof createMockPlanner>;
  let executor: ReturnType<typeof createMockExecutor>;
  let reporter: ReturnType<typeof createMockReporter>;
  let pipeline: IterationPipeline;

  beforeEach(() => {
    planner = createMockPlanner();
    executor = createMockExecutor();
    reporter = createMockReporter();
    pipeline = new IterationPipeline(planner, executor, reporter, "/repo");
  });

  describe("checkPendingIterPR", () => {
    it("returns null when gh command fails (no gh CLI)", async () => {
      const result = await pipeline.checkPendingIterPR();
      // gh is unlikely to be configured in test env, so expect null
      expect(result).toBeNull();
    });
  });

  describe("runSingleStep", () => {
    it("skips with no_steps when no opportunities found", async () => {
      planner = createMockPlanner(makeAnalysis([]));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep();

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("no_steps");
    });

    it("skips with no_steps when plan generation fails", async () => {
      const analysis = makeAnalysis([
        {
          source: "todo",
          title: "Fix something",
          description: "Fix it",
          priority: "medium",
        },
      ]);
      planner = createMockPlanner(analysis, { success: false, error: "nope" });
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep();

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("no_steps");
    });

    it("skips with no_steps when plan has empty steps", async () => {
      const analysis = makeAnalysis([
        {
          source: "todo",
          title: "Fix something",
          description: "Fix it",
          priority: "medium",
        },
      ]);
      const planResult: PlanResult = {
        success: true,
        plan: {
          id: "p1",
          name: "Empty",
          description: "empty",
          steps: [],
          estimatedDuration: 0,
          priority: "low",
          status: "planned",
        },
      };
      planner = createMockPlanner(analysis, planResult);
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep();

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("no_steps");
    });

    it("returns step without executing in dryRun mode", async () => {
      const step = makeStep();
      const analysis = makeAnalysis([
        {
          source: "todo",
          title: "Fix foo",
          description: "Fix the foo module",
          priority: "medium",
        },
      ]);
      planner = createMockPlanner(analysis, makePlanResult(step));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep({ dryRun: true });

      expect(result.skipped).toBe(false);
      expect(result.step).toEqual(step);
      expect(result.pr).toBeUndefined();
      expect(executor.executeStep).not.toHaveBeenCalled();
    });

    it("calls planner.analyze and planner.generatePlan in sequence", async () => {
      const analysis = makeAnalysis([
        {
          source: "todo",
          title: "Fix foo",
          description: "Fix it",
          priority: "high",
        },
      ]);
      const step = makeStep();
      planner = createMockPlanner(analysis, makePlanResult(step));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      await pipeline.runSingleStep({ dryRun: true });

      expect(planner.analyze).toHaveBeenCalledOnce();
      expect(planner.generatePlan).toHaveBeenCalledWith(
        analysis.opportunities[0],
      );
    });
  });

  describe("getAffectedFiles (via pipeline internals)", () => {
    it("returns step.target as affected file in dryRun", async () => {
      const step = makeStep({ target: "src/bar.ts" });
      const analysis = makeAnalysis([
        {
          source: "backlog",
          title: "T",
          description: "D",
          priority: "low",
        },
      ]);
      planner = createMockPlanner(analysis, makePlanResult(step));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep({ dryRun: true });

      expect(result.step?.target).toBe("src/bar.ts");
    });
  });

  describe("slugify (via branch naming)", () => {
    // Tested indirectly — the pipeline creates branches with slugified names.
    // We verify the step description flows through correctly.
    it("step description is preserved in result", async () => {
      const step = makeStep({ description: "Fix the Foo Module!!!" });
      const analysis = makeAnalysis([
        {
          source: "todo",
          title: "T",
          description: "D",
          priority: "low",
        },
      ]);
      planner = createMockPlanner(analysis, makePlanResult(step));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep({ dryRun: true });

      expect(result.step?.description).toBe("Fix the Foo Module!!!");
    });
  });

  describe("PipelineResult shape", () => {
    it("skipped result has correct shape", async () => {
      planner = createMockPlanner(makeAnalysis([]));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep();

      expect(result).toMatchObject({
        skipped: true,
        skipReason: "no_steps",
      });
      expect(result.step).toBeUndefined();
      expect(result.pr).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("dryRun result has correct shape", async () => {
      const step = makeStep();
      const analysis = makeAnalysis([
        {
          source: "todo",
          title: "T",
          description: "D",
          priority: "low",
        },
      ]);
      planner = createMockPlanner(analysis, makePlanResult(step));
      pipeline = new IterationPipeline(planner, executor, reporter, "/repo");

      const result = await pipeline.runSingleStep({ dryRun: true });

      expect(result).toMatchObject({
        skipped: false,
        step: expect.objectContaining({ id: "step-1" }),
      });
      expect(result.skipReason).toBeUndefined();
      expect(result.executionResult).toBeUndefined();
    });
  });
});
