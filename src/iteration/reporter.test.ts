// src/iteration/reporter.test.ts — Unit tests for iteration reporter

import { describe, it, expect } from "vitest";
import { IterationReporter, createReporter } from "./reporter.js";
import type { IterationPlan, IterationStep, AnalysisResult } from "./types.js";
import type { ExecutionResult, StepResult } from "./executor.js";

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

function createTestPlan(steps: IterationStep[] = []): IterationPlan {
  return {
    id: "test-plan-1",
    name: "Test Plan",
    description: "A test plan description",
    steps,
    estimatedDuration: 15,
    priority: "medium",
    status: "planned",
    createdAt: new Date("2026-01-15T10:00:00Z"),
    updatedAt: new Date("2026-01-15T10:30:00Z"),
  };
}

function createTestStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    success: true,
    duration: 150,
    output: "Step completed",
    ...overrides,
  };
}

function createTestExecutionResult(
  plan: IterationPlan,
  stepResults: Map<string, StepResult>,
  success = true,
): ExecutionResult {
  const completedSteps = [...stepResults.values()].filter((r) => r.success).length;
  return {
    plan,
    success,
    completedSteps,
    totalSteps: plan.steps.length,
    results: stepResults,
    totalDuration: 500,
  };
}

function createTestAnalysisResult(): AnalysisResult {
  return {
    opportunities: [
      {
        source: "backlog",
        title: "Refactor auth module",
        description: "The auth module needs refactoring",
        location: "src/auth/index.ts",
        priority: "high",
        tags: ["refactor"],
      },
      {
        source: "todo",
        title: "Fix memory leak",
        description: "Memory leak in event handlers",
        location: "src/events.ts:42",
        priority: "critical",
      },
      {
        source: "analysis",
        title: "Add unit tests",
        description: "Coverage is below threshold",
        priority: "medium",
      },
    ],
    stats: {
      total: 3,
      bySource: {
        backlog: 1,
        todo: 1,
        issue: 0,
        analysis: 1,
      },
      byPriority: {
        low: 0,
        medium: 1,
        high: 1,
        critical: 1,
      },
    },
    errors: ["Failed to parse backlog section: Dependencies"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IterationReporter", () => {
  describe("constructor", () => {
    it("creates reporter instance", () => {
      const reporter = new IterationReporter();
      expect(reporter).toBeInstanceOf(IterationReporter);
    });
  });

  describe("generateReport", () => {
    describe("text format", () => {
      it("generates basic text report for successful execution", () => {
        const reporter = new IterationReporter();
        const step = createTestStep({ status: "completed" });
        const plan = createTestPlan([step]);
        plan.status = "completed";

        const results = new Map<string, StepResult>();
        results.set(step.id, createTestStepResult());

        const execResult = createTestExecutionResult(plan, results, true);

        const report = reporter.generateReport(execResult, { format: "text" });

        expect(report).toContain("[OK]");
        expect(report).toContain("Test Plan");
        expect(report).toContain("1/1 steps");
      });

      it("generates text report for failed execution", () => {
        const reporter = new IterationReporter();
        const step = createTestStep({ status: "failed" });
        const plan = createTestPlan([step]);
        plan.status = "failed";

        const results = new Map<string, StepResult>();
        results.set(
          step.id,
          createTestStepResult({
            success: false,
            error: new Error("Step failed"),
          }),
        );

        const execResult = createTestExecutionResult(plan, results, false);

        const report = reporter.generateReport(execResult, { format: "text" });

        expect(report).toContain("[FAILED]");
        expect(report).toContain("0/1 steps");
      });

      it("includes duration when option is set", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);
        plan.status = "completed";

        const execResult = createTestExecutionResult(plan, new Map(), true);

        const report = reporter.generateReport(execResult, {
          format: "text",
          includeDuration: true,
        });

        expect(report).toContain("Duration:");
        expect(report).toContain("500ms");
      });

      it("includes timestamps when option is set", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);
        plan.status = "completed";

        const execResult = createTestExecutionResult(plan, new Map(), true);

        const report = reporter.generateReport(execResult, {
          format: "text",
          includeTimestamps: true,
        });

        expect(report).toContain("Completed:");
        expect(report).toContain("2026-01-15");
      });

      it("includes step details when verbose", () => {
        const reporter = new IterationReporter();
        const step = createTestStep({ status: "completed" });
        const plan = createTestPlan([step]);
        plan.status = "completed";

        const results = new Map<string, StepResult>();
        results.set(step.id, createTestStepResult());

        const execResult = createTestExecutionResult(plan, results, true);

        const report = reporter.generateReport(execResult, {
          format: "text",
          verbose: true,
        });

        expect(report).toContain("Steps:");
        expect(report).toContain("Test Step");
      });
    });

    describe("json format", () => {
      it("generates valid JSON", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);
        plan.status = "completed";

        const execResult = createTestExecutionResult(plan, new Map(), true);

        const report = reporter.generateReport(execResult, { format: "json" });
        const parsed = JSON.parse(report);

        expect(parsed.success).toBe(true);
        expect(parsed.plan.name).toBe("Test Plan");
        expect(parsed.completedSteps).toBe(0);
        expect(parsed.totalSteps).toBe(0);
      });

      it("includes duration in JSON when option is set", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);
        const execResult = createTestExecutionResult(plan, new Map(), true);

        const report = reporter.generateReport(execResult, {
          format: "json",
          includeDuration: true,
        });
        const parsed = JSON.parse(report);

        expect(parsed.totalDuration).toBe(500);
      });

      it("includes timestamps in JSON when option is set", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);
        const execResult = createTestExecutionResult(plan, new Map(), true);

        const report = reporter.generateReport(execResult, {
          format: "json",
          includeTimestamps: true,
        });
        const parsed = JSON.parse(report);

        expect(parsed.timestamps.createdAt).toBe("2026-01-15T10:00:00.000Z");
        expect(parsed.timestamps.updatedAt).toBe("2026-01-15T10:30:00.000Z");
      });

      it("includes steps in JSON when verbose", () => {
        const reporter = new IterationReporter();
        const step = createTestStep({ status: "completed" });
        const plan = createTestPlan([step]);

        const results = new Map<string, StepResult>();
        results.set(step.id, createTestStepResult());

        const execResult = createTestExecutionResult(plan, results, true);

        const report = reporter.generateReport(execResult, {
          format: "json",
          verbose: true,
        });
        const parsed = JSON.parse(report);

        expect(parsed.steps).toHaveLength(1);
        expect(parsed.steps[0].name).toBe("Test Step");
        expect(parsed.steps[0].success).toBe(true);
      });
    });

    describe("markdown format", () => {
      it("generates markdown with header", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);
        plan.status = "completed";

        const execResult = createTestExecutionResult(plan, new Map(), true);

        const report = reporter.generateReport(execResult, { format: "markdown" });

        expect(report).toContain("## ✅ Test Plan");
        expect(report).toContain("**Status:** Completed");
        expect(report).toContain("**Progress:** 0/0 steps");
      });

      it("shows failure status in markdown", () => {
        const reporter = new IterationReporter();
        const step = createTestStep({ status: "failed" });
        const plan = createTestPlan([step]);
        plan.status = "failed";

        const results = new Map<string, StepResult>();
        results.set(
          step.id,
          createTestStepResult({
            success: false,
            error: new Error("Something went wrong"),
          }),
        );

        const execResult = createTestExecutionResult(plan, results, false);

        const report = reporter.generateReport(execResult, { format: "markdown" });

        expect(report).toContain("## ❌ Test Plan");
        expect(report).toContain("**Status:** Failed");
      });

      it("includes step list when verbose", () => {
        const reporter = new IterationReporter();
        const step = createTestStep({ status: "completed" });
        const plan = createTestPlan([step]);

        const results = new Map<string, StepResult>();
        results.set(step.id, createTestStepResult());

        const execResult = createTestExecutionResult(plan, results, true);

        const report = reporter.generateReport(execResult, {
          format: "markdown",
          verbose: true,
        });

        expect(report).toContain("### Steps");
        expect(report).toContain("✅");
        expect(report).toContain("**Test Step**");
      });
    });
  });

  describe("generatePlanSummary", () => {
    describe("text format", () => {
      it("generates basic plan summary", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([createTestStep()]);

        const summary = reporter.generatePlanSummary(plan, { format: "text" });

        expect(summary).toContain("Plan: Test Plan");
        expect(summary).toContain("Status: planned");
        expect(summary).toContain("Priority: medium");
        expect(summary).toContain("Steps: 1");
      });

      it("includes estimated duration", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);

        const summary = reporter.generatePlanSummary(plan, {
          format: "text",
          includeDuration: true,
        });

        expect(summary).toContain("Estimated: 15 min");
      });

      it("includes description when verbose", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([]);

        const summary = reporter.generatePlanSummary(plan, {
          format: "text",
          verbose: true,
        });

        expect(summary).toContain("Description: A test plan description");
      });
    });

    describe("json format", () => {
      it("generates valid JSON summary", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([createTestStep()]);

        const summary = reporter.generatePlanSummary(plan, { format: "json" });
        const parsed = JSON.parse(summary);

        expect(parsed.id).toBe("test-plan-1");
        expect(parsed.name).toBe("Test Plan");
        expect(parsed.status).toBe("planned");
        expect(parsed.stepCount).toBe(1);
      });

      it("includes steps when verbose", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const plan = createTestPlan([step]);

        const summary = reporter.generatePlanSummary(plan, {
          format: "json",
          verbose: true,
        });
        const parsed = JSON.parse(summary);

        expect(parsed.steps).toHaveLength(1);
        expect(parsed.steps[0].id).toBe("test-step-1");
        expect(parsed.steps[0].action).toBe("modify");
      });
    });

    describe("markdown format", () => {
      it("generates markdown summary", () => {
        const reporter = new IterationReporter();
        const plan = createTestPlan([createTestStep()]);

        const summary = reporter.generatePlanSummary(plan, { format: "markdown" });

        expect(summary).toContain("## Test Plan");
        expect(summary).toContain("**Status:** planned");
        expect(summary).toContain("**Steps:** 1");
      });

      it("includes step list when verbose", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const plan = createTestPlan([step]);

        const summary = reporter.generatePlanSummary(plan, {
          format: "markdown",
          verbose: true,
        });

        expect(summary).toContain("### Steps");
        expect(summary).toContain("**Test Step**");
        expect(summary).toContain("`modify`");
        expect(summary).toContain("`src/test.ts`");
      });
    });
  });

  describe("generateAnalysisReport", () => {
    describe("text format", () => {
      it("generates analysis summary", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, { format: "text" });

        expect(report).toContain("3 opportunities found");
        expect(report).toContain("By Priority:");
        expect(report).toContain("critical: 1");
        expect(report).toContain("high: 1");
        expect(report).toContain("By Source:");
        expect(report).toContain("backlog: 1");
        expect(report).toContain("todo: 1");
      });

      it("includes opportunities when verbose", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, {
          format: "text",
          verbose: true,
        });

        expect(report).toContain("Opportunities:");
        expect(report).toContain("Refactor auth module");
        expect(report).toContain("Fix memory leak");
      });

      it("includes errors if present", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, { format: "text" });

        expect(report).toContain("Errors:");
        expect(report).toContain("Failed to parse backlog section");
      });
    });

    describe("json format", () => {
      it("generates valid JSON analysis", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, { format: "json" });
        const parsed = JSON.parse(report);

        expect(parsed.stats.total).toBe(3);
        expect(parsed.stats.byPriority.critical).toBe(1);
        expect(parsed.errors).toContain("Failed to parse backlog section: Dependencies");
      });

      it("includes opportunities when verbose", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, {
          format: "json",
          verbose: true,
        });
        const parsed = JSON.parse(report);

        expect(parsed.opportunities).toHaveLength(3);
        expect(parsed.opportunities[0].title).toBe("Refactor auth module");
      });
    });

    describe("markdown format", () => {
      it("generates markdown tables", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, { format: "markdown" });

        expect(report).toContain("## Analysis Results");
        expect(report).toContain("**3** improvement opportunities");
        expect(report).toContain("### By Priority");
        expect(report).toContain("| Priority | Count |");
        expect(report).toContain("| critical | 1 |");
        expect(report).toContain("### By Source");
        expect(report).toContain("| Source | Count |");
      });

      it("includes opportunity details when verbose", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, {
          format: "markdown",
          verbose: true,
        });

        expect(report).toContain("### Opportunities");
        expect(report).toContain("🔴"); // critical
        expect(report).toContain("🟠"); // high
        expect(report).toContain("**Refactor auth module**");
      });

      it("includes errors section", () => {
        const reporter = new IterationReporter();
        const analysis = createTestAnalysisResult();

        const report = reporter.generateAnalysisReport(analysis, { format: "markdown" });

        expect(report).toContain("### Errors");
        expect(report).toContain("⚠️");
      });
    });
  });

  describe("formatStepResult", () => {
    describe("text format", () => {
      it("formats successful step", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult();

        const formatted = reporter.formatStepResult(step, result, { format: "text" });

        expect(formatted).toContain("[OK]");
        expect(formatted).toContain("Test Step");
      });

      it("formats failed step with error", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult({
          success: false,
          error: new Error("Something broke"),
        });

        const formatted = reporter.formatStepResult(step, result, { format: "text" });

        expect(formatted).toContain("[FAILED]");
        expect(formatted).toContain("Error: Something broke");
      });

      it("includes duration when option is set", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult({ duration: 1500 });

        const formatted = reporter.formatStepResult(step, result, {
          format: "text",
          includeDuration: true,
        });

        expect(formatted).toContain("1.5s");
      });

      it("includes output when verbose", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult({ output: "Created file" });

        const formatted = reporter.formatStepResult(step, result, {
          format: "text",
          verbose: true,
        });

        expect(formatted).toContain("Output: Created file");
      });
    });

    describe("json format", () => {
      it("formats step result as JSON", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult();

        const formatted = reporter.formatStepResult(step, result, { format: "json" });
        const parsed = JSON.parse(formatted);

        expect(parsed.id).toBe("test-step-1");
        expect(parsed.name).toBe("Test Step");
        expect(parsed.success).toBe(true);
      });

      it("includes error in JSON for failed step", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult({
          success: false,
          error: new Error("Failed!"),
        });

        const formatted = reporter.formatStepResult(step, result, { format: "json" });
        const parsed = JSON.parse(formatted);

        expect(parsed.error).toBe("Failed!");
      });
    });

    describe("markdown format", () => {
      it("formats successful step with emoji", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult();

        const formatted = reporter.formatStepResult(step, result, { format: "markdown" });

        expect(formatted).toContain("✅");
        expect(formatted).toContain("**Test Step**");
      });

      it("formats failed step with error", () => {
        const reporter = new IterationReporter();
        const step = createTestStep();
        const result = createTestStepResult({
          success: false,
          error: new Error("Failed!"),
        });

        const formatted = reporter.formatStepResult(step, result, { format: "markdown" });

        expect(formatted).toContain("❌");
        expect(formatted).toContain("`Failed!`");
      });
    });
  });

  describe("duration formatting", () => {
    it("formats milliseconds", () => {
      const reporter = new IterationReporter();
      const step = createTestStep();
      const result = createTestStepResult({ duration: 50 });

      const formatted = reporter.formatStepResult(step, result, {
        format: "text",
        includeDuration: true,
      });

      expect(formatted).toContain("50ms");
    });

    it("formats seconds", () => {
      const reporter = new IterationReporter();
      const step = createTestStep();
      const result = createTestStepResult({ duration: 2500 });

      const formatted = reporter.formatStepResult(step, result, {
        format: "text",
        includeDuration: true,
      });

      expect(formatted).toContain("2.5s");
    });

    it("formats minutes and seconds", () => {
      const reporter = new IterationReporter();
      const step = createTestStep();
      const result = createTestStepResult({ duration: 95000 });

      const formatted = reporter.formatStepResult(step, result, {
        format: "text",
        includeDuration: true,
      });

      expect(formatted).toContain("1m 35s");
    });
  });

  describe("createReporter", () => {
    it("creates reporter instance", () => {
      const reporter = createReporter();
      expect(reporter).toBeInstanceOf(IterationReporter);
    });
  });

  describe("default options", () => {
    it("uses text format by default", () => {
      const reporter = new IterationReporter();
      const plan = createTestPlan([]);
      const execResult = createTestExecutionResult(plan, new Map(), true);

      const report = reporter.generateReport(execResult);

      expect(report).toContain("[OK]");
      expect(report).not.toContain("{");
    });

    it("includes duration by default", () => {
      const reporter = new IterationReporter();
      const plan = createTestPlan([]);
      const execResult = createTestExecutionResult(plan, new Map(), true);

      const report = reporter.generateReport(execResult);

      expect(report).toContain("Duration:");
    });

    it("excludes timestamps by default", () => {
      const reporter = new IterationReporter();
      const plan = createTestPlan([]);
      const execResult = createTestExecutionResult(plan, new Map(), true);

      const report = reporter.generateReport(execResult);

      expect(report).not.toContain("Completed:");
    });

    it("excludes verbose details by default", () => {
      const reporter = new IterationReporter();
      const step = createTestStep();
      const plan = createTestPlan([step]);
      const results = new Map<string, StepResult>();
      results.set(step.id, createTestStepResult());
      const execResult = createTestExecutionResult(plan, results, true);

      const report = reporter.generateReport(execResult);

      expect(report).not.toContain("Steps:");
    });
  });
});
