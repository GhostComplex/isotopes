// src/iteration/reporter.ts — Iteration reporting module
// Generates human-readable reports for iteration plans and execution results.

import type {
  IterationPlan,
  IterationStep,
  AnalysisResult,
  ImprovementOpportunity,
} from "./types.js";
import type { ExecutionResult, StepResult } from "./executor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Report output format. */
export type ReportFormat = "text" | "json" | "markdown";

/** Options for report generation. */
export interface ReportOptions {
  /** Output format */
  format: ReportFormat;
  /** Include timestamps in the report */
  includeTimestamps?: boolean;
  /** Include duration information */
  includeDuration?: boolean;
  /** Include additional details */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: ReportOptions = {
  format: "text",
  includeTimestamps: false,
  includeDuration: true,
  verbose: false,
};

// ---------------------------------------------------------------------------
// Reporter implementation
// ---------------------------------------------------------------------------

/**
 * Iteration reporter that generates human-readable reports.
 */
export class IterationReporter {
  /**
   * Generate a report for an execution result.
   */
  generateReport(result: ExecutionResult, options?: Partial<ReportOptions>): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    switch (opts.format) {
      case "json":
        return this.generateJsonReport(result, opts);
      case "markdown":
        return this.generateMarkdownReport(result, opts);
      case "text":
      default:
        return this.generateTextReport(result, opts);
    }
  }

  /**
   * Generate a summary for an iteration plan.
   */
  generatePlanSummary(plan: IterationPlan, options?: Partial<ReportOptions>): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    switch (opts.format) {
      case "json":
        return this.generateJsonPlanSummary(plan, opts);
      case "markdown":
        return this.generateMarkdownPlanSummary(plan, opts);
      case "text":
      default:
        return this.generateTextPlanSummary(plan, opts);
    }
  }

  /**
   * Generate a report for an analysis result.
   */
  generateAnalysisReport(
    analysis: AnalysisResult,
    options?: Partial<ReportOptions>,
  ): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    switch (opts.format) {
      case "json":
        return this.generateJsonAnalysisReport(analysis, opts);
      case "markdown":
        return this.generateMarkdownAnalysisReport(analysis, opts);
      case "text":
      default:
        return this.generateTextAnalysisReport(analysis, opts);
    }
  }

  /**
   * Format a single step result.
   */
  formatStepResult(
    step: IterationStep,
    result: StepResult,
    options?: Partial<ReportOptions>,
  ): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    switch (opts.format) {
      case "json":
        return this.formatJsonStepResult(step, result, opts);
      case "markdown":
        return this.formatMarkdownStepResult(step, result, opts);
      case "text":
      default:
        return this.formatTextStepResult(step, result, opts);
    }
  }

  // ---------------------------------------------------------------------------
  // Text format
  // ---------------------------------------------------------------------------

  private generateTextReport(result: ExecutionResult, opts: ReportOptions): string {
    const lines: string[] = [];
    const { plan, success, completedSteps, totalSteps, totalDuration } = result;

    // Header
    const statusIcon = success ? "[OK]" : "[FAILED]";
    lines.push(`${statusIcon} Plan: ${plan.name}`);
    lines.push(`Progress: ${completedSteps}/${totalSteps} steps`);

    if (opts.includeDuration) {
      lines.push(`Duration: ${this.formatDuration(totalDuration)}`);
    }

    if (opts.includeTimestamps && plan.updatedAt) {
      lines.push(`Completed: ${plan.updatedAt.toISOString()}`);
    }

    // Step details
    if (opts.verbose && plan.steps.length > 0) {
      lines.push("");
      lines.push("Steps:");
      for (const step of plan.steps) {
        const stepResult = result.results.get(step.id);
        if (stepResult) {
          lines.push(this.formatTextStepResult(step, stepResult, opts));
        } else {
          lines.push(`  [ ] ${step.name} (not executed)`);
        }
      }
    }

    return lines.join("\n");
  }

  private generateTextPlanSummary(plan: IterationPlan, opts: ReportOptions): string {
    const lines: string[] = [];

    lines.push(`Plan: ${plan.name}`);
    lines.push(`Status: ${plan.status}`);
    lines.push(`Priority: ${plan.priority}`);
    lines.push(`Steps: ${plan.steps.length}`);

    if (opts.includeDuration) {
      lines.push(`Estimated: ${plan.estimatedDuration} min`);
    }

    if (opts.includeTimestamps) {
      if (plan.createdAt) {
        lines.push(`Created: ${plan.createdAt.toISOString()}`);
      }
      if (plan.updatedAt) {
        lines.push(`Updated: ${plan.updatedAt.toISOString()}`);
      }
    }

    if (opts.verbose && plan.description) {
      lines.push("");
      lines.push(`Description: ${plan.description}`);
    }

    if (opts.verbose && plan.steps.length > 0) {
      lines.push("");
      lines.push("Steps:");
      for (const step of plan.steps) {
        const statusIcon = this.getStepStatusIcon(step.status);
        lines.push(`  ${statusIcon} ${step.name} (${step.action} -> ${step.target})`);
      }
    }

    return lines.join("\n");
  }

  private generateTextAnalysisReport(
    analysis: AnalysisResult,
    opts: ReportOptions,
  ): string {
    const lines: string[] = [];

    lines.push(`Analysis Results: ${analysis.stats.total} opportunities found`);
    lines.push("");
    lines.push("By Priority:");
    for (const [priority, count] of Object.entries(analysis.stats.byPriority)) {
      if (count > 0) {
        lines.push(`  ${priority}: ${count}`);
      }
    }

    lines.push("");
    lines.push("By Source:");
    for (const [source, count] of Object.entries(analysis.stats.bySource)) {
      if (count > 0) {
        lines.push(`  ${source}: ${count}`);
      }
    }

    if (opts.verbose && analysis.opportunities.length > 0) {
      lines.push("");
      lines.push("Opportunities:");
      for (const opp of analysis.opportunities) {
        lines.push(this.formatTextOpportunity(opp));
      }
    }

    if (analysis.errors && analysis.errors.length > 0) {
      lines.push("");
      lines.push("Errors:");
      for (const error of analysis.errors) {
        lines.push(`  - ${error}`);
      }
    }

    return lines.join("\n");
  }

  private formatTextStepResult(
    step: IterationStep,
    result: StepResult,
    opts: ReportOptions,
  ): string {
    const statusIcon = result.success ? "[OK]" : "[FAILED]";
    let line = `  ${statusIcon} ${step.name}`;

    if (opts.includeDuration) {
      line += ` (${this.formatDuration(result.duration)})`;
    }

    if (!result.success && result.error) {
      line += `\n    Error: ${result.error.message}`;
    }

    if (opts.verbose && result.output) {
      line += `\n    Output: ${result.output}`;
    }

    return line;
  }

  private formatTextOpportunity(opp: ImprovementOpportunity): string {
    let line = `  [${opp.priority.toUpperCase()}] ${opp.title}`;
    if (opp.location) {
      line += ` (${opp.location})`;
    }
    return line;
  }

  // ---------------------------------------------------------------------------
  // JSON format
  // ---------------------------------------------------------------------------

  private generateJsonReport(result: ExecutionResult, opts: ReportOptions): string {
    const data: Record<string, unknown> = {
      success: result.success,
      plan: {
        id: result.plan.id,
        name: result.plan.name,
        status: result.plan.status,
      },
      completedSteps: result.completedSteps,
      totalSteps: result.totalSteps,
    };

    if (opts.includeDuration) {
      data.totalDuration = result.totalDuration;
    }

    if (opts.includeTimestamps) {
      data.timestamps = {
        createdAt: result.plan.createdAt?.toISOString(),
        updatedAt: result.plan.updatedAt?.toISOString(),
      };
    }

    if (opts.verbose) {
      data.steps = result.plan.steps.map((step) => {
        const stepResult = result.results.get(step.id);
        return {
          id: step.id,
          name: step.name,
          status: step.status,
          success: stepResult?.success,
          duration: opts.includeDuration ? stepResult?.duration : undefined,
          error: stepResult?.error?.message,
          output: stepResult?.output,
        };
      });
    }

    return JSON.stringify(data, null, 2);
  }

  private generateJsonPlanSummary(plan: IterationPlan, opts: ReportOptions): string {
    const data: Record<string, unknown> = {
      id: plan.id,
      name: plan.name,
      status: plan.status,
      priority: plan.priority,
      stepCount: plan.steps.length,
    };

    if (opts.includeDuration) {
      data.estimatedDuration = plan.estimatedDuration;
    }

    if (opts.includeTimestamps) {
      data.createdAt = plan.createdAt?.toISOString();
      data.updatedAt = plan.updatedAt?.toISOString();
    }

    if (opts.verbose) {
      data.description = plan.description;
      data.steps = plan.steps.map((step) => ({
        id: step.id,
        name: step.name,
        action: step.action,
        target: step.target,
        status: step.status,
        dependencies: step.dependencies,
      }));
    }

    return JSON.stringify(data, null, 2);
  }

  private generateJsonAnalysisReport(
    analysis: AnalysisResult,
    opts: ReportOptions,
  ): string {
    const data: Record<string, unknown> = {
      stats: analysis.stats,
    };

    if (opts.verbose) {
      data.opportunities = analysis.opportunities;
    }

    if (analysis.errors && analysis.errors.length > 0) {
      data.errors = analysis.errors;
    }

    return JSON.stringify(data, null, 2);
  }

  private formatJsonStepResult(
    step: IterationStep,
    result: StepResult,
    opts: ReportOptions,
  ): string {
    const data: Record<string, unknown> = {
      id: step.id,
      name: step.name,
      success: result.success,
    };

    if (opts.includeDuration) {
      data.duration = result.duration;
    }

    if (!result.success && result.error) {
      data.error = result.error.message;
    }

    if (opts.verbose && result.output) {
      data.output = result.output;
    }

    return JSON.stringify(data, null, 2);
  }

  // ---------------------------------------------------------------------------
  // Markdown format
  // ---------------------------------------------------------------------------

  private generateMarkdownReport(result: ExecutionResult, opts: ReportOptions): string {
    const lines: string[] = [];
    const { plan, success, completedSteps, totalSteps, totalDuration } = result;

    // Header
    const statusEmoji = success ? "✅" : "❌";
    lines.push(`## ${statusEmoji} ${plan.name}`);
    lines.push("");

    // Summary
    lines.push(`**Status:** ${success ? "Completed" : "Failed"}`);
    lines.push(`**Progress:** ${completedSteps}/${totalSteps} steps`);

    if (opts.includeDuration) {
      lines.push(`**Duration:** ${this.formatDuration(totalDuration)}`);
    }

    if (opts.includeTimestamps && plan.updatedAt) {
      lines.push(`**Completed:** ${plan.updatedAt.toISOString()}`);
    }

    // Step details
    if (opts.verbose && plan.steps.length > 0) {
      lines.push("");
      lines.push("### Steps");
      lines.push("");
      for (const step of plan.steps) {
        const stepResult = result.results.get(step.id);
        if (stepResult) {
          lines.push(this.formatMarkdownStepResult(step, stepResult, opts));
        } else {
          lines.push(`- ⏸️ **${step.name}** — not executed`);
        }
      }
    }

    return lines.join("\n");
  }

  private generateMarkdownPlanSummary(plan: IterationPlan, opts: ReportOptions): string {
    const lines: string[] = [];

    lines.push(`## ${plan.name}`);
    lines.push("");
    lines.push(`**Status:** ${plan.status}`);
    lines.push(`**Priority:** ${plan.priority}`);
    lines.push(`**Steps:** ${plan.steps.length}`);

    if (opts.includeDuration) {
      lines.push(`**Estimated:** ${plan.estimatedDuration} min`);
    }

    if (opts.includeTimestamps) {
      if (plan.createdAt) {
        lines.push(`**Created:** ${plan.createdAt.toISOString()}`);
      }
      if (plan.updatedAt) {
        lines.push(`**Updated:** ${plan.updatedAt.toISOString()}`);
      }
    }

    if (opts.verbose && plan.description) {
      lines.push("");
      lines.push(`> ${plan.description}`);
    }

    if (opts.verbose && plan.steps.length > 0) {
      lines.push("");
      lines.push("### Steps");
      lines.push("");
      for (const step of plan.steps) {
        const statusEmoji = this.getStepStatusEmoji(step.status);
        lines.push(`- ${statusEmoji} **${step.name}** — \`${step.action}\` → \`${step.target}\``);
      }
    }

    return lines.join("\n");
  }

  private generateMarkdownAnalysisReport(
    analysis: AnalysisResult,
    opts: ReportOptions,
  ): string {
    const lines: string[] = [];

    lines.push(`## Analysis Results`);
    lines.push("");
    lines.push(`Found **${analysis.stats.total}** improvement opportunities.`);
    lines.push("");

    // Priority breakdown
    lines.push("### By Priority");
    lines.push("");
    lines.push("| Priority | Count |");
    lines.push("|----------|-------|");
    for (const [priority, count] of Object.entries(analysis.stats.byPriority)) {
      if (count > 0) {
        lines.push(`| ${priority} | ${count} |`);
      }
    }

    // Source breakdown
    lines.push("");
    lines.push("### By Source");
    lines.push("");
    lines.push("| Source | Count |");
    lines.push("|--------|-------|");
    for (const [source, count] of Object.entries(analysis.stats.bySource)) {
      if (count > 0) {
        lines.push(`| ${source} | ${count} |`);
      }
    }

    if (opts.verbose && analysis.opportunities.length > 0) {
      lines.push("");
      lines.push("### Opportunities");
      lines.push("");
      for (const opp of analysis.opportunities) {
        lines.push(this.formatMarkdownOpportunity(opp));
      }
    }

    if (analysis.errors && analysis.errors.length > 0) {
      lines.push("");
      lines.push("### Errors");
      lines.push("");
      for (const error of analysis.errors) {
        lines.push(`- ⚠️ ${error}`);
      }
    }

    return lines.join("\n");
  }

  private formatMarkdownStepResult(
    step: IterationStep,
    result: StepResult,
    opts: ReportOptions,
  ): string {
    const statusEmoji = result.success ? "✅" : "❌";
    let line = `- ${statusEmoji} **${step.name}**`;

    if (opts.includeDuration) {
      line += ` (${this.formatDuration(result.duration)})`;
    }

    if (!result.success && result.error) {
      line += `\n  - Error: \`${result.error.message}\``;
    }

    if (opts.verbose && result.output) {
      line += `\n  - Output: \`${result.output}\``;
    }

    return line;
  }

  private formatMarkdownOpportunity(opp: ImprovementOpportunity): string {
    const priorityEmoji = this.getPriorityEmoji(opp.priority);
    let line = `- ${priorityEmoji} **${opp.title}**`;
    if (opp.location) {
      line += ` (\`${opp.location}\`)`;
    }
    if (opp.description) {
      line += `\n  - ${opp.description}`;
    }
    return line;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  }

  private getStepStatusIcon(status: string): string {
    switch (status) {
      case "completed":
        return "[OK]";
      case "failed":
        return "[FAILED]";
      case "in-progress":
        return "[...]";
      case "pending":
      default:
        return "[ ]";
    }
  }

  private getStepStatusEmoji(status: string): string {
    switch (status) {
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "in-progress":
        return "🔄";
      case "pending":
      default:
        return "⏸️";
    }
  }

  private getPriorityEmoji(priority: string): string {
    switch (priority) {
      case "critical":
        return "🔴";
      case "high":
        return "🟠";
      case "medium":
        return "🟡";
      case "low":
      default:
        return "🟢";
    }
  }
}

/**
 * Create a new iteration reporter instance.
 */
export function createReporter(): IterationReporter {
  return new IterationReporter();
}
