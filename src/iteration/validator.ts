// src/iteration/validator.ts — Iteration plan validation module
// Validates iteration plans and steps for correctness and safety.

import path from "node:path";
import type { IterationPlan, IterationStep, StepAction } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validation error with code and context. */
export interface ValidationError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Step ID if error relates to a specific step */
  step?: string;
  /** Field name if error relates to a specific field */
  field?: string;
}

/** Validation warning with code and context. */
export interface ValidationWarning {
  /** Warning code for programmatic handling */
  code: string;
  /** Human-readable warning message */
  message: string;
  /** Step ID if warning relates to a specific step */
  step?: string;
  /** Field name if warning relates to a specific field */
  field?: string;
}

/** Result of a validation operation. */
export interface ValidationResult {
  /** Whether validation passed without errors */
  valid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
  /** List of validation warnings */
  warnings: ValidationWarning[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid step action types. */
const VALID_ACTIONS: Set<StepAction> = new Set([
  "create",
  "modify",
  "delete",
  "test",
  "deploy",
]);

// ---------------------------------------------------------------------------
// Validator implementation
// ---------------------------------------------------------------------------

/**
 * Iteration validator that checks plans and steps for correctness.
 */
export class IterationValidator {
  /**
   * Validate an entire iteration plan.
   * Checks plan structure, steps, and dependencies.
   */
  validatePlan(plan: IterationPlan): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Validate plan fields
    if (!plan.name || plan.name.trim() === "") {
      errors.push({
        code: "PLAN_NAME_REQUIRED",
        message: "Plan must have a name",
        field: "name",
      });
    }

    if (!plan.steps || plan.steps.length === 0) {
      errors.push({
        code: "PLAN_STEPS_REQUIRED",
        message: "Plan must have at least one step",
        field: "steps",
      });
    }

    // Validate each step
    if (plan.steps) {
      const stepIds = new Set<string>();
      for (const step of plan.steps) {
        // Check for duplicate step IDs
        if (stepIds.has(step.id)) {
          errors.push({
            code: "DUPLICATE_STEP_ID",
            message: `Duplicate step ID: ${step.id}`,
            step: step.id,
            field: "id",
          });
        }
        stepIds.add(step.id);

        // Validate the step itself
        const stepResult = this.validateStep(step);
        errors.push(...stepResult.errors);
        warnings.push(...stepResult.warnings);
      }

      // Validate dependencies
      const depResult = this.validateDependencies(plan);
      errors.push(...depResult.errors);
      warnings.push(...depResult.warnings);
    }

    // Add warnings for optional issues
    if (!plan.description || plan.description.trim() === "") {
      warnings.push({
        code: "PLAN_NO_DESCRIPTION",
        message: "Plan has no description",
        field: "description",
      });
    }

    if (plan.estimatedDuration <= 0) {
      warnings.push({
        code: "PLAN_INVALID_DURATION",
        message: "Plan has no estimated duration",
        field: "estimatedDuration",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a single iteration step.
   */
  validateStep(step: IterationStep): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Required fields
    if (!step.id || step.id.trim() === "") {
      errors.push({
        code: "STEP_ID_REQUIRED",
        message: "Step must have an ID",
        step: step.id,
        field: "id",
      });
    }

    if (!step.name || step.name.trim() === "") {
      errors.push({
        code: "STEP_NAME_REQUIRED",
        message: "Step must have a name",
        step: step.id,
        field: "name",
      });
    }

    if (!step.action) {
      errors.push({
        code: "STEP_ACTION_REQUIRED",
        message: "Step must have an action",
        step: step.id,
        field: "action",
      });
    } else if (!VALID_ACTIONS.has(step.action)) {
      errors.push({
        code: "STEP_INVALID_ACTION",
        message: `Invalid action: ${step.action}. Must be one of: ${[...VALID_ACTIONS].join(", ")}`,
        step: step.id,
        field: "action",
      });
    }

    if (!step.target || step.target.trim() === "") {
      errors.push({
        code: "STEP_TARGET_REQUIRED",
        message: "Step must have a target",
        step: step.id,
        field: "target",
      });
    }

    // Optional field warnings
    if (!step.description || step.description.trim() === "") {
      warnings.push({
        code: "STEP_NO_DESCRIPTION",
        message: `Step "${step.id}" has no description`,
        step: step.id,
        field: "description",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate dependency graph for cycles and missing references.
   */
  validateDependencies(plan: IterationPlan): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!plan.steps || plan.steps.length === 0) {
      return { valid: true, errors, warnings };
    }

    const stepIds = new Set(plan.steps.map((s) => s.id));

    // Check for missing dependencies
    for (const step of plan.steps) {
      for (const depId of step.dependencies) {
        if (!stepIds.has(depId)) {
          errors.push({
            code: "DEPENDENCY_NOT_FOUND",
            message: `Step "${step.id}" depends on non-existent step "${depId}"`,
            step: step.id,
            field: "dependencies",
          });
        }
      }
    }

    // Check for circular dependencies using DFS
    const cycle = this.detectCycle(plan.steps);
    if (cycle) {
      errors.push({
        code: "CIRCULAR_DEPENDENCY",
        message: `Circular dependency detected: ${cycle.join(" -> ")}`,
        step: cycle[0],
        field: "dependencies",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate that all step targets are within allowed paths.
   */
  validateTargets(plan: IterationPlan, allowedPaths: string[]): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!plan.steps || allowedPaths.length === 0) {
      return { valid: true, errors, warnings };
    }

    // Normalize allowed paths
    const normalizedAllowed = allowedPaths.map((p) => path.normalize(p));

    for (const step of plan.steps) {
      if (!step.target) continue;

      // Extract file path (remove line number suffix if present)
      const targetPath = step.target.replace(/:\d+$/, "");
      const normalizedTarget = path.normalize(targetPath);

      // Check if target is within any allowed path
      const isAllowed = normalizedAllowed.some((allowed) => {
        // Handle both file and directory allowed paths
        if (normalizedTarget === allowed) return true;
        if (normalizedTarget.startsWith(allowed + path.sep)) return true;
        // Check if allowed path is a parent directory
        const relativePath = path.relative(allowed, normalizedTarget);
        return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
      });

      if (!isAllowed) {
        errors.push({
          code: "TARGET_OUTSIDE_ALLOWED_PATHS",
          message: `Step "${step.id}" target "${step.target}" is outside allowed paths`,
          step: step.id,
          field: "target",
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Detect cycles in the dependency graph using DFS.
   * Returns the cycle path if found, or null if no cycle exists.
   */
  private detectCycle(steps: IterationStep[]): string[] | null {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (stepId: string): string[] | null => {
      visited.add(stepId);
      recursionStack.add(stepId);
      path.push(stepId);

      const step = stepMap.get(stepId);
      if (step) {
        for (const depId of step.dependencies) {
          if (!visited.has(depId)) {
            const cycle = dfs(depId);
            if (cycle) return cycle;
          } else if (recursionStack.has(depId)) {
            // Found cycle, extract the cycle path
            const cycleStart = path.indexOf(depId);
            return [...path.slice(cycleStart), depId];
          }
        }
      }

      path.pop();
      recursionStack.delete(stepId);
      return null;
    };

    for (const step of steps) {
      if (!visited.has(step.id)) {
        const cycle = dfs(step.id);
        if (cycle) return cycle;
      }
    }

    return null;
  }
}

/**
 * Create a new iteration validator instance.
 */
export function createValidator(): IterationValidator {
  return new IterationValidator();
}
