// src/iteration/validator.test.ts — Unit tests for iteration validator

import { describe, it, expect } from "vitest";
import { IterationValidator, createValidator } from "./validator.js";
import type { IterationPlan, IterationStep } from "./types.js";

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

function createTestPlan(
  steps: IterationStep[],
  overrides: Partial<IterationPlan> = {},
): IterationPlan {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IterationValidator", () => {
  describe("validatePlan", () => {
    it("validates a valid plan", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([createTestStep()]);

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("requires plan name", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([createTestStep()], { name: "" });

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "PLAN_NAME_REQUIRED",
          field: "name",
        }),
      );
    });

    it("requires at least one step", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([]);

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "PLAN_STEPS_REQUIRED",
          field: "steps",
        }),
      );
    });

    it("detects duplicate step IDs", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1" }),
        createTestStep({ id: "step-1" }), // Duplicate
      ]);

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "DUPLICATE_STEP_ID",
          step: "step-1",
        }),
      );
    });

    it("validates all steps in plan", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", name: "" }), // Invalid
        createTestStep({ id: "step-2", target: "" }), // Invalid
      ]);

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("warns about missing description", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([createTestStep()], { description: "" });

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "PLAN_NO_DESCRIPTION",
          field: "description",
        }),
      );
    });

    it("warns about invalid duration", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([createTestStep()], { estimatedDuration: 0 });

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "PLAN_INVALID_DURATION",
          field: "estimatedDuration",
        }),
      );
    });

    it("includes dependency validation errors", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", dependencies: ["non-existent"] }),
      ]);

      const result = validator.validatePlan(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "DEPENDENCY_NOT_FOUND",
        }),
      );
    });
  });

  describe("validateStep", () => {
    it("validates a valid step", () => {
      const validator = new IterationValidator();
      const step = createTestStep();

      const result = validator.validateStep(step);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("requires step ID", () => {
      const validator = new IterationValidator();
      const step = createTestStep({ id: "" });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "STEP_ID_REQUIRED",
          field: "id",
        }),
      );
    });

    it("requires step name", () => {
      const validator = new IterationValidator();
      const step = createTestStep({ name: "" });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "STEP_NAME_REQUIRED",
          field: "name",
        }),
      );
    });

    it("requires step action", () => {
      const validator = new IterationValidator();
      const step = createTestStep({ action: "" as never });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "STEP_ACTION_REQUIRED",
          field: "action",
        }),
      );
    });

    it("validates action type", () => {
      const validator = new IterationValidator();
      const step = createTestStep({ action: "invalid" as never });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "STEP_INVALID_ACTION",
          field: "action",
        }),
      );
    });

    it("accepts all valid action types", () => {
      const validator = new IterationValidator();
      const actions = ["create", "modify", "delete", "test", "deploy"] as const;

      for (const action of actions) {
        const step = createTestStep({ action });
        const result = validator.validateStep(step);
        expect(result.valid).toBe(true);
      }
    });

    it("requires step target", () => {
      const validator = new IterationValidator();
      const step = createTestStep({ target: "" });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "STEP_TARGET_REQUIRED",
          field: "target",
        }),
      );
    });

    it("warns about missing description", () => {
      const validator = new IterationValidator();
      const step = createTestStep({ description: "" });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "STEP_NO_DESCRIPTION",
          field: "description",
        }),
      );
    });

    it("reports multiple errors", () => {
      const validator = new IterationValidator();
      const step = createTestStep({
        id: "",
        name: "",
        target: "",
      });

      const result = validator.validateStep(step);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("validateDependencies", () => {
    it("validates plan with no dependencies", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1" }),
        createTestStep({ id: "step-2" }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("validates valid dependencies", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1" }),
        createTestStep({ id: "step-2", dependencies: ["step-1"] }),
        createTestStep({ id: "step-3", dependencies: ["step-1", "step-2"] }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects missing dependencies", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", dependencies: ["non-existent"] }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "DEPENDENCY_NOT_FOUND",
          message: expect.stringContaining("non-existent"),
        }),
      );
    });

    it("detects simple circular dependency", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", dependencies: ["step-2"] }),
        createTestStep({ id: "step-2", dependencies: ["step-1"] }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "CIRCULAR_DEPENDENCY",
        }),
      );
    });

    it("detects self-referencing dependency", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", dependencies: ["step-1"] }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "CIRCULAR_DEPENDENCY",
        }),
      );
    });

    it("detects transitive circular dependency", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", dependencies: ["step-3"] }),
        createTestStep({ id: "step-2", dependencies: ["step-1"] }),
        createTestStep({ id: "step-3", dependencies: ["step-2"] }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "CIRCULAR_DEPENDENCY",
        }),
      );
    });

    it("handles empty plan", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("reports multiple missing dependencies", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", dependencies: ["missing-1", "missing-2"] }),
      ]);

      const result = validator.validateDependencies(plan);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe("validateTargets", () => {
    it("validates targets within allowed paths", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "src/module.ts" }),
        createTestStep({ id: "step-2", target: "src/utils/helper.ts" }),
      ]);

      const result = validator.validateTargets(plan, ["src"]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects targets outside allowed paths", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "outside/file.ts" }),
      ]);

      const result = validator.validateTargets(plan, ["src"]);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "TARGET_OUTSIDE_ALLOWED_PATHS",
          step: "step-1",
        }),
      );
    });

    it("handles multiple allowed paths", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "src/module.ts" }),
        createTestStep({ id: "step-2", target: "tests/module.test.ts" }),
        createTestStep({ id: "step-3", target: "docs/readme.md" }),
      ]);

      const result = validator.validateTargets(plan, ["src", "tests", "docs"]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("handles targets with line numbers", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "src/module.ts:42" }),
      ]);

      const result = validator.validateTargets(plan, ["src"]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("handles exact file matches", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "config.json" }),
      ]);

      const result = validator.validateTargets(plan, ["config.json"]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("validates with empty allowed paths", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "src/module.ts" }),
      ]);

      const result = validator.validateTargets(plan, []);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("validates empty plan", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([]);

      const result = validator.validateTargets(plan, ["src"]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects parent directory traversal", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "src/../outside/file.ts" }),
      ]);

      const result = validator.validateTargets(plan, ["src"]);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "TARGET_OUTSIDE_ALLOWED_PATHS",
        }),
      );
    });

    it("reports multiple invalid targets", () => {
      const validator = new IterationValidator();
      const plan = createTestPlan([
        createTestStep({ id: "step-1", target: "outside/file1.ts" }),
        createTestStep({ id: "step-2", target: "other/file2.ts" }),
      ]);

      const result = validator.validateTargets(plan, ["src"]);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe("createValidator", () => {
    it("creates validator instance", () => {
      const validator = createValidator();
      expect(validator).toBeInstanceOf(IterationValidator);
    });
  });
});
