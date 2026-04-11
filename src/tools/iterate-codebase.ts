// src/tools/iterate-codebase.ts — Tool wrapper for the IterationPipeline
// Registers iterate_codebase as a tool that agents can invoke.

import type { Tool } from "../core/types.js";
import type { ToolHandler, ToolEntry } from "../core/tools.js";
import { IterationPipeline } from "../iteration/pipeline.js";
import { IterationPlanner } from "../iteration/planner.js";
import { IterationExecutor } from "../iteration/executor.js";
import { IterationReporter } from "../iteration/reporter.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("tools:iterate-codebase");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterateCodebaseConfig {
  /** Path to the workspace directory (for planner analysis) */
  workspacePath: string;
  /** Path to the repository root (for git/PR operations) */
  repoPath: string;
}

interface IterateCodebaseArgs {
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const ITERATE_CODEBASE_TOOL: Tool = {
  name: "iterate_codebase",
  description: `Run one iteration step: analyze codebase → plan → execute → validate → open PR.

Scans for improvement opportunities (TODOs, backlog items), picks the highest-priority one,
executes a single step, validates with tsc + vitest, then opens a PR on an iter/* branch.

Safety:
- Skips if an open iter/* PR already exists (no concurrent runs)
- All changes go through PR, never pushed directly to main
- Selective git add (only affected files)

Use dryRun: true to see the plan without executing.`,
  parameters: {
    type: "object",
    properties: {
      dryRun: {
        type: "boolean",
        description:
          "If true, generate and return the plan without executing or creating a PR",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

function createIterateCodebaseHandler(
  config: IterateCodebaseConfig,
): ToolHandler {
  return async (rawArgs: unknown): Promise<string> => {
    const args = (rawArgs ?? {}) as IterateCodebaseArgs;

    log.info(`iterate_codebase: dryRun=${args.dryRun ?? false}`);

    const planner = new IterationPlanner({
      workspacePath: config.workspacePath,
    });
    const executor = new IterationExecutor({
      workspacePath: config.workspacePath,
    });
    const reporter = new IterationReporter();

    const pipeline = new IterationPipeline(
      planner,
      executor,
      reporter,
      config.repoPath,
    );

    try {
      const result = await pipeline.runSingleStep({
        dryRun: args.dryRun,
      });
      return JSON.stringify(result, null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`iterate_codebase failed: ${message}`);
      return JSON.stringify({ success: false, error: message });
    }
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIterateCodebaseTool(
  config: IterateCodebaseConfig,
): ToolEntry {
  return {
    tool: ITERATE_CODEBASE_TOOL,
    handler: createIterateCodebaseHandler(config),
  };
}

export { ITERATE_CODEBASE_TOOL };
