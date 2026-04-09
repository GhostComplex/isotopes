// src/iteration/planner.ts — Iteration planning module
// Analyzes codebase state and generates improvement plans.

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  IterationPlan,
  IterationStep,
  ImprovementOpportunity,
  PlannerOptions,
  AnalysisResult,
  PlanResult,
  Priority,
  OpportunitySource,
} from "./types.js";

// Default patterns for finding TODO comments
const DEFAULT_TODO_PATTERNS = ["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx"];

// Directories to skip when scanning for TODOs
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);

// Regex for matching TODO comments
const TODO_REGEX = /(?:\/\/|#|\/\*|\*)\s*(?:TODO|FIXME|HACK|XXX)(?:\([^)]*\))?:?\s*(.+?)(?:\*\/)?$/gim;

// Priority keywords in backlog entries
const PRIORITY_KEYWORDS: Record<string, Priority> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * Iteration planner that analyzes codebases and generates improvement plans.
 */
export class IterationPlanner {
  private readonly options: Required<PlannerOptions>;

  constructor(options: PlannerOptions) {
    this.options = {
      workspacePath: options.workspacePath,
      backlogPath: options.backlogPath ?? "docs/ongoing/BACKLOG.md",
      todoPatterns: options.todoPatterns ?? DEFAULT_TODO_PATTERNS,
      maxOpportunities: options.maxOpportunities ?? 50,
      minPriority: options.minPriority ?? "low",
    };
  }

  /**
   * Analyze the codebase and identify improvement opportunities.
   */
  async analyze(): Promise<AnalysisResult> {
    const opportunities: ImprovementOpportunity[] = [];
    const errors: string[] = [];

    // Gather opportunities from all sources in parallel
    const [backlogOpportunities, todoOpportunities] = await Promise.all([
      this.scanBacklog().catch((err) => {
        errors.push(`Backlog scan failed: ${err.message}`);
        return [] as ImprovementOpportunity[];
      }),
      this.scanTodos().catch((err) => {
        errors.push(`TODO scan failed: ${err.message}`);
        return [] as ImprovementOpportunity[];
      }),
    ]);

    opportunities.push(...backlogOpportunities);
    opportunities.push(...todoOpportunities);

    // Filter by minimum priority
    const filtered = this.filterByPriority(opportunities);

    // Sort by priority (critical first)
    const sorted = this.sortByPriority(filtered);

    // Limit results
    const limited = sorted.slice(0, this.options.maxOpportunities);

    // Compute stats
    const stats = this.computeStats(limited);

    return {
      opportunities: limited,
      stats,
      ...(errors.length > 0 && { errors }),
    };
  }

  /**
   * Generate an iteration plan from an improvement opportunity.
   */
  generatePlan(opportunity: ImprovementOpportunity): PlanResult {
    try {
      const steps = this.generateSteps(opportunity);
      const estimatedDuration = this.estimateDuration(steps);

      const plan: IterationPlan = {
        id: randomUUID(),
        name: opportunity.title,
        description: opportunity.description,
        steps,
        estimatedDuration,
        priority: opportunity.priority,
        status: "planned",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return { success: true, plan };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Generate multiple plans from analysis results.
   */
  generatePlans(analysis: AnalysisResult, limit = 5): PlanResult[] {
    return analysis.opportunities.slice(0, limit).map((opp) => this.generatePlan(opp));
  }

  /**
   * Scan the backlog file for improvement opportunities.
   */
  private async scanBacklog(): Promise<ImprovementOpportunity[]> {
    const backlogPath = path.isAbsolute(this.options.backlogPath)
      ? this.options.backlogPath
      : path.join(this.options.workspacePath, this.options.backlogPath);

    let content: string;
    try {
      content = await fs.readFile(backlogPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // No backlog file, that's OK
        return [];
      }
      throw err;
    }

    return this.parseBacklog(content);
  }

  /**
   * Parse backlog markdown content into opportunities.
   */
  private parseBacklog(content: string): ImprovementOpportunity[] {
    const opportunities: ImprovementOpportunity[] = [];
    const sections = content.split(/^##\s+/m).filter(Boolean);

    for (const section of sections) {
      const lines = section.trim().split("\n");
      if (lines.length === 0) continue;

      const title = lines[0].trim();
      // Skip the main header and empty titles
      if (!title || title.toLowerCase() === "backlog" || title.startsWith("#")) continue;

      // Extract priority from content
      let priority: Priority = "medium";
      const priorityMatch = section.match(/\*\*Priority:\*\*\s*(\w+)/i);
      if (priorityMatch) {
        const key = priorityMatch[1].toLowerCase();
        if (key in PRIORITY_KEYWORDS) {
          priority = PRIORITY_KEYWORDS[key];
        }
      }

      // Extract description (content after title, before next section marker)
      const descriptionLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("---")) break;
        descriptionLines.push(line);
      }

      const description = descriptionLines
        .join("\n")
        .replace(/\*\*[^*]+:\*\*\s*\S+\s*/g, "") // Remove metadata fields
        .trim();

      if (title) {
        opportunities.push({
          source: "backlog",
          title,
          description: description || `Implement: ${title}`,
          priority,
        });
      }
    }

    return opportunities;
  }

  /**
   * Scan source files for TODO comments.
   */
  private async scanTodos(): Promise<ImprovementOpportunity[]> {
    const opportunities: ImprovementOpportunity[] = [];
    const files = await this.findSourceFiles();

    for (const file of files) {
      const todos = await this.extractTodosFromFile(file);
      opportunities.push(...todos);
    }

    return opportunities;
  }

  /**
   * Find all source files matching the configured patterns.
   */
  private async findSourceFiles(): Promise<string[]> {
    const files: string[] = [];
    await this.walkDirectory(this.options.workspacePath, files);
    return files;
  }

  /**
   * Recursively walk directory to find matching files.
   */
  private async walkDirectory(dir: string, files: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, files);
      } else if (entry.isFile() && this.matchesPattern(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  /**
   * Check if a filename matches configured patterns.
   */
  private matchesPattern(filename: string): boolean {
    const ext = path.extname(filename);
    return [".ts", ".js", ".tsx", ".jsx"].includes(ext);
  }

  /**
   * Extract TODO comments from a file.
   */
  private async extractTodosFromFile(
    filePath: string,
  ): Promise<ImprovementOpportunity[]> {
    const opportunities: ImprovementOpportunity[] = [];

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      return opportunities;
    }

    const relativePath = path.relative(this.options.workspacePath, filePath);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = TODO_REGEX.exec(line);
      TODO_REGEX.lastIndex = 0; // Reset regex state

      if (match) {
        const todoText = match[1].trim();
        const priority = this.inferPriorityFromTodo(line);

        opportunities.push({
          source: "todo",
          title: todoText.length > 60 ? todoText.slice(0, 57) + "..." : todoText,
          description: todoText,
          location: `${relativePath}:${i + 1}`,
          priority,
        });
      }
    }

    return opportunities;
  }

  /**
   * Infer priority from TODO comment type.
   */
  private inferPriorityFromTodo(line: string): Priority {
    const upper = line.toUpperCase();
    if (upper.includes("FIXME") || upper.includes("XXX")) return "high";
    if (upper.includes("HACK")) return "medium";
    return "low";
  }

  /**
   * Generate steps for an iteration plan.
   */
  private generateSteps(opportunity: ImprovementOpportunity): IterationStep[] {
    const steps: IterationStep[] = [];
    const baseId = randomUUID().slice(0, 8);

    // Analyze step
    steps.push({
      id: `${baseId}-analyze`,
      name: "Analyze current state",
      description: `Understand the current implementation related to: ${opportunity.title}`,
      action: "modify",
      target: opportunity.location ?? this.options.workspacePath,
      dependencies: [],
      status: "pending",
    });

    // Implement step
    steps.push({
      id: `${baseId}-implement`,
      name: "Implement changes",
      description: opportunity.description,
      action: opportunity.source === "todo" ? "modify" : "create",
      target: opportunity.location ?? "src/",
      dependencies: [`${baseId}-analyze`],
      status: "pending",
    });

    // Test step
    const testTarget = opportunity.location
      ? opportunity.location.replace(/\.ts(:\d+)?$/, ".test.ts$1")
      : "tests/";
    steps.push({
      id: `${baseId}-test`,
      name: "Add or update tests",
      description: "Ensure changes are properly tested",
      action: "test",
      target: testTarget,
      dependencies: [`${baseId}-implement`],
      status: "pending",
    });

    return steps;
  }

  /**
   * Estimate duration based on steps.
   */
  private estimateDuration(steps: IterationStep[]): number {
    // Simple heuristic: 15 min per step
    return steps.length * 15;
  }

  /**
   * Filter opportunities by minimum priority.
   */
  private filterByPriority(
    opportunities: ImprovementOpportunity[],
  ): ImprovementOpportunity[] {
    const priorityRank: Record<Priority, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    const minRank = priorityRank[this.options.minPriority];
    return opportunities.filter((opp) => priorityRank[opp.priority] >= minRank);
  }

  /**
   * Sort opportunities by priority (highest first).
   */
  private sortByPriority(
    opportunities: ImprovementOpportunity[],
  ): ImprovementOpportunity[] {
    const priorityRank: Record<Priority, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    return [...opportunities].sort(
      (a, b) => priorityRank[b.priority] - priorityRank[a.priority],
    );
  }

  /**
   * Compute statistics from opportunities.
   */
  private computeStats(opportunities: ImprovementOpportunity[]): AnalysisResult["stats"] {
    const bySource: Record<OpportunitySource, number> = {
      backlog: 0,
      todo: 0,
      issue: 0,
      analysis: 0,
    };

    const byPriority: Record<Priority, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    for (const opp of opportunities) {
      bySource[opp.source]++;
      byPriority[opp.priority]++;
    }

    return {
      total: opportunities.length,
      bySource,
      byPriority,
    };
  }
}

/**
 * Create a new iteration planner instance.
 */
export function createPlanner(options: PlannerOptions): IterationPlanner {
  return new IterationPlanner(options);
}
