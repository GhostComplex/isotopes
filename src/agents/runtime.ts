import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { createLogger } from "../core/logger.js";
import type { RunnerKind, RunEvent, RunOptions } from "./types.js";
import type { ResolvedSubagentConfig, SubagentType } from "../core/config.js";
import type { PiMonoCore } from "../core/pi-mono.js";
import type { Runner } from "./runner.js";
import { ExternalRunner } from "./runners/external.js";
import { InProcessRunner } from "./runners/in-process.js";

const log = createLogger("agents:runtime");

export const MAX_CONCURRENT_RUNS = 5;

interface RunHandle {
  abort: AbortController;
}

const runs = new Map<string, RunHandle>();

export interface AgentRuntimeOptions {
  allowedWorkspaceRoots?: string[];
  config?: ResolvedSubagentConfig;
  core?: PiMonoCore;
  runners?: Partial<Record<RunnerKind, Runner>>;
}

export class AgentRuntime {
  private allowedRoots: string[];
  private runners: Partial<Record<RunnerKind, Runner>>;
  private allowedTypes: Set<SubagentType>;
  public workspacesKey: string;

  constructor(options?: AgentRuntimeOptions) {
    const opts = options ?? {};

    this.allowedRoots = opts.allowedWorkspaceRoots ?? [];
    this.workspacesKey = this.allowedRoots.slice().sort().join(":");
    this.allowedTypes = opts.config?.allowedTypes ?? new Set(["claude", "builtin"]);

    if (opts.runners) {
      this.runners = { ...opts.runners };
    } else {
      this.runners = {};
      if (this.allowedTypes.has("claude")) {
        const claude = opts.config?.claude;
        this.runners["external"] = new ExternalRunner({
          permissionMode: claude?.permissionMode,
          allowedTools: claude?.allowedTools,
          settingSources: claude?.settingSources,
        });
      }
      if (this.allowedTypes.has("builtin") && opts.core) {
        this.runners["in-process"] = new InProcessRunner(opts.core);
      }
    }
  }

  validateCwd(cwd: string): void {
    const resolved = resolve(cwd);
    let normalized: string;
    try {
      normalized = realpathSync(resolved);
    } catch {
      normalized = normalize(resolved);
    }

    if (!existsSync(normalized)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    if (!statSync(normalized).isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }

    if (this.allowedRoots.length > 0) {
      const isAllowed = this.allowedRoots.some((root) => {
        let normalizedRoot: string;
        try {
          normalizedRoot = realpathSync(resolve(root));
        } catch {
          normalizedRoot = normalize(resolve(root));
        }
        return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + "/");
      });
      if (!isAllowed) {
        throw new Error(`Working directory outside allowed workspaces: ${cwd}`);
      }
    }
  }

  validateRunner(runner: RunnerKind): void {
    const agentType = runner === "external" ? "claude" : "builtin";
    if (!this.allowedTypes.has(agentType as SubagentType)) {
      throw new Error(`Runner "${runner}" not allowed. Allowed types: ${[...this.allowedTypes].join(", ")}`);
    }
  }

  async *spawn(
    runId: string,
    options: RunOptions,
  ): AsyncGenerator<RunEvent> {
    this.validateRunner(options.runner);
    this.validateCwd(options.cwd);

    const runner = this.runners[options.runner];
    if (!runner) {
      throw new Error(
        `No runner registered for "${options.runner}". ` +
          (options.runner === "in-process"
            ? "Pass `core` when constructing AgentRuntime to enable in-process runners."
            : "Check AgentRuntime configuration."),
      );
    }

    if (runs.size >= MAX_CONCURRENT_RUNS) {
      throw new Error(
        `Max concurrent runs reached (${MAX_CONCURRENT_RUNS}). Cancel existing runs first.`,
      );
    }

    const abortController = new AbortController();
    runs.set(runId, { abort: abortController });

    log.info(`Spawning ${options.runner} run`, { runId, cwd: options.cwd });

    yield { type: "run:start" };

    const timeoutSec = options.timeout ?? 900;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutSec * 1000);
    timeoutHandle.unref();

    let sawDone = false;
    try {
      for await (const ev of runner.run(runId, options, { abort: abortController.signal })) {
        if (ev.type === "run:done") sawDone = true;
        yield ev;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "run:error", error: msg };
      if (!sawDone) {
        yield { type: "run:done", exitCode: 1 };
        sawDone = true;
      }
    } finally {
      clearTimeout(timeoutHandle);
      runs.delete(runId);
    }

    if (!sawDone) {
      yield { type: "run:done", exitCode: 0 };
    }

    log.info(`${options.runner} run completed`, { runId });
  }

  cancel(runId: string): boolean {
    const handle = runs.get(runId);
    if (!handle) return false;
    log.info("Cancelling run", { runId });
    handle.abort.abort();
    return true;
  }

  isRunning(runId: string): boolean {
    return runs.has(runId);
  }

  get activeCount(): number {
    return runs.size;
  }

  cancelAll(): void {
    for (const runId of [...runs.keys()]) {
      this.cancel(runId);
    }
  }
}
