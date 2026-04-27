import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { createLogger } from "../core/logger.js";
import type { RunEvent, RunOptions } from "./types.js";
import { summarizeEvents } from "./helpers.js";
import type { ResolvedSpawningConfig } from "../core/config.js";
import type { PiMonoCore } from "../core/pi-mono.js";
import type { Runner } from "./runner.js";
import { ClaudeRunner } from "./runners/claude.js";
import { BuiltinRunner } from "./runners/builtin.js";

const log = createLogger("agents:runtime");

export const MAX_CONCURRENT_RUNS = 5;
export const DEFAULT_MAX_DEPTH = 1;

interface RunHandle {
  abort: AbortController;
}

export interface AgentRuntimeOptions {
  allowedWorkspaceRoots?: string[];
  config?: ResolvedSpawningConfig;
  core?: PiMonoCore;
  externalRunners?: Record<string, Runner>;
}

export class AgentRuntime {
  private allowedRoots: string[];
  private externalRunners: Map<string, Runner>;
  private builtinRunner?: BuiltinRunner;
  private runs = new Map<string, RunHandle>();
  public workspacesKey: string;

  constructor(options?: AgentRuntimeOptions) {
    const opts = options ?? {};

    this.allowedRoots = opts.allowedWorkspaceRoots ?? [];
    this.workspacesKey = this.allowedRoots.slice().sort().join(":");

    if (opts.externalRunners) {
      this.externalRunners = new Map(Object.entries(opts.externalRunners));
    } else {
      this.externalRunners = new Map();
      const claude = opts.config?.claude;
      this.externalRunners.set("claude", new ClaudeRunner({
        permissionMode: claude?.permissionMode,
        allowedTools: claude?.allowedTools,
        settingSources: claude?.settingSources,
      }));
    }

    if (opts.core) {
      this.builtinRunner = new BuiltinRunner(opts.core);
    }
  }

  getExternalRunnerIds(): string[] {
    return [...this.externalRunners.keys()];
  }

  hasBuiltinRunner(): boolean {
    return this.builtinRunner !== undefined;
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

  private resolveRunner(agentId: string): Runner {
    const external = this.externalRunners.get(agentId);
    if (external) return external;

    if (this.builtinRunner) return this.builtinRunner;

    throw new Error(
      `No runner available for agent "${agentId}". ` +
      "Pass `core` when constructing AgentRuntime to enable builtin runners.",
    );
  }

  async *spawn(
    runId: string,
    options: RunOptions,
  ): AsyncGenerator<RunEvent> {
    const depth = options.depth ?? 0;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (depth >= maxDepth) {
      throw new Error(
        `Max agent nesting depth reached (depth=${depth}, maxDepth=${maxDepth}). ` +
          "Spawning further agents is not allowed at this depth.",
      );
    }

    this.validateCwd(options.cwd);
    const runner = this.resolveRunner(options.agentId);

    if (this.runs.size >= MAX_CONCURRENT_RUNS) {
      throw new Error(
        `Max concurrent runs reached (${MAX_CONCURRENT_RUNS}). Cancel existing runs first.`,
      );
    }

    const abortController = new AbortController();
    this.runs.set(runId, { abort: abortController });

    log.info(`Spawning run for agent "${options.agentId}"`, { runId, cwd: options.cwd });

    yield { type: "run:start" };

    const timeoutSec = options.timeout ?? 900;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutSec * 1000);
    timeoutHandle.unref();

    const collected: RunEvent[] = [{ type: "run:start" }];
    let sawDone = false;
    try {
      for await (const ev of runner.run(runId, options, { abort: abortController.signal })) {
        if (ev.type === "run:done") sawDone = true;
        collected.push(ev);
        yield ev;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEv: RunEvent = { type: "run:error", error: msg };
      collected.push(errEv);
      yield errEv;
      if (!sawDone) {
        const doneEv: RunEvent = { type: "run:done", exitCode: 1 };
        collected.push(doneEv);
        yield doneEv;
        sawDone = true;
      }
    } finally {
      clearTimeout(timeoutHandle);
      this.runs.delete(runId);
    }

    if (!sawDone) {
      const doneEv: RunEvent = { type: "run:done", exitCode: 0 };
      collected.push(doneEv);
      yield doneEv;
    }

    log.info(`Run completed for agent "${options.agentId}"`, { runId });

    if (options.onComplete) {
      try {
        await options.onComplete(summarizeEvents(collected));
      } catch (err) {
        log.warn("onComplete callback failed", { runId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  cancel(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    log.info("Cancelling run", { runId });
    handle.abort.abort();
    return true;
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  get activeCount(): number {
    return this.runs.size;
  }

  cancelAll(): void {
    for (const runId of [...this.runs.keys()]) {
      this.cancel(runId);
    }
  }
}
