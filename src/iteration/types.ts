// src/iteration/types.ts — Type definitions for the iteration planning system
// Defines structures for iteration plans, steps, and improvement opportunities.

/**
 * Priority levels for plans and improvements.
 */
export type Priority = "low" | "medium" | "high" | "critical";

/**
 * Status of an iteration plan.
 */
export type PlanStatus = "planned" | "in-progress" | "completed" | "failed";

/**
 * Status of an iteration step.
 */
export type StepStatus = "pending" | "in-progress" | "completed" | "failed";

/**
 * Type of action for an iteration step.
 */
export type StepAction = "create" | "modify" | "delete" | "test" | "deploy";

/**
 * Source of an improvement opportunity.
 */
export type OpportunitySource = "backlog" | "todo" | "issue" | "analysis";

/**
 * Represents an iteration plan with multiple steps.
 */
export interface IterationPlan {
  /** Unique identifier for the plan */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this plan accomplishes */
  description: string;
  /** Ordered list of steps to execute */
  steps: IterationStep[];
  /** Estimated duration in minutes */
  estimatedDuration: number;
  /** Priority level */
  priority: Priority;
  /** Current status */
  status: PlanStatus;
  /** When the plan was created */
  createdAt?: Date;
  /** When the plan was last updated */
  updatedAt?: Date;
}

/**
 * Represents a single step within an iteration plan.
 */
export interface IterationStep {
  /** Unique identifier for the step */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this step does */
  description: string;
  /** Type of action to perform */
  action: StepAction;
  /** Target file path or component name */
  target: string;
  /** IDs of steps that must complete before this one */
  dependencies: string[];
  /** Current status */
  status: StepStatus;
  /** Optional error message if failed */
  error?: string;
  /** Optional output from execution */
  output?: string;
}

/**
 * Represents an opportunity for improvement in the codebase.
 */
export interface ImprovementOpportunity {
  /** Where this opportunity was discovered */
  source: OpportunitySource;
  /** Title of the improvement */
  title: string;
  /** Description of what could be improved */
  description: string;
  /** File path or location in codebase (optional) */
  location?: string;
  /** Priority level */
  priority: Priority;
  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Options for the iteration planner.
 */
export interface PlannerOptions {
  /** Path to the workspace/codebase to analyze */
  workspacePath: string;
  /** Path to backlog file (default: docs/ongoing/BACKLOG.md) */
  backlogPath?: string;
  /** Glob patterns for files to scan for TODOs */
  todoPatterns?: string[];
  /** Maximum number of opportunities to return */
  maxOpportunities?: number;
  /** Minimum priority to include */
  minPriority?: Priority;
}

/**
 * Result from analyzing the codebase for improvements.
 */
export interface AnalysisResult {
  /** List of discovered improvement opportunities */
  opportunities: ImprovementOpportunity[];
  /** Summary statistics */
  stats: {
    /** Total opportunities found */
    total: number;
    /** Count by source */
    bySource: Record<OpportunitySource, number>;
    /** Count by priority */
    byPriority: Record<Priority, number>;
  };
  /** Any errors encountered during analysis */
  errors?: string[];
}

/**
 * Result from generating an iteration plan.
 */
export interface PlanResult {
  /** Whether plan generation succeeded */
  success: boolean;
  /** The generated plan (if successful) */
  plan?: IterationPlan;
  /** Error message (if failed) */
  error?: string;
}
