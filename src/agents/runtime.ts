import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger.js";
import type {
  RunEvent,
  RunOptions,
  AgentSessionKind,
  RegisteredAgent,
  SendMessageRequest,
  RunInfo,
} from "./types.js";
import { summarizeEvents } from "./helpers.js";
import type { ResolvedSpawningConfig } from "../core/config.js";
import type { PiMonoCore } from "../core/pi-mono.js";
import type { Runner } from "./runner.js";
import { ClaudeRunner } from "./runners/claude.js";
import { BuiltinRunner } from "./runners/builtin.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

const log = createLogger("agents:runtime");

export const MAX_CONCURRENT_RUNS = 5;
export const DEFAULT_MAX_DEPTH = 1;
export const LEAF_CONCURRENCY_CAP = 5;
export const LEAF_DEFAULT_TIMEOUT_SEC = 900;
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(["subagent", "claude"]);

interface RunHandle {
  abort: AbortController;
}

interface RunHandleV2 {
  runId: string;
  agentId: string;
  kind: AgentSessionKind;
  sessionId: string;
  startedAt: number;
  abort: AbortController;
  parentSessionId?: string;
  session?: AgentSession;
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
  private runsV2 = new Map<string, RunHandleV2>();
  private agents = new Map<string, RegisteredAgent>();
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
    const v2 = this.runsV2.get(runId);
    if (v2) {
      log.info("Cancelling run (v2)", { runId, agentId: v2.agentId });
      v2.abort.abort();
      return true;
    }
    const handle = this.runs.get(runId);
    if (!handle) return false;
    log.info("Cancelling run", { runId });
    handle.abort.abort();
    return true;
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId) || this.runsV2.has(runId);
  }

  get activeCount(): number {
    return this.runs.size + this.runsV2.size;
  }

  cancelAll(): void {
    for (const runId of [...this.runs.keys()]) this.cancel(runId);
    for (const runId of [...this.runsV2.keys()]) this.cancel(runId);
  }

  // -------------------------------------------------------------------------
  // New unified API (issue #568) — additive alongside spawn().
  // -------------------------------------------------------------------------

  registerAgent(agent: RegisteredAgent): void {
    if (RESERVED_AGENT_IDS.has(agent.id)) {
      throw new Error(`Cannot register agent with reserved magic id: ${agent.id}`);
    }
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, agent);
    log.debug(`Registered agent: ${agent.id}`);
  }

  unregisterAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  getAgent(id: string): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  listAgents(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  /**
   * Single execution verb. `to === "subagent"` produces an ephemeral leaf
   * session (requires `leafContext`); any other id resolves to a registered
   * agent (root session). The `claude` magic id is not yet supported through
   * this path — fall back to spawn() for Claude CLI subagents.
   */
  async *sendMessage(req: SendMessageRequest): AsyncGenerator<AgentEvent> {
    if (req.to === "claude") {
      throw new Error("sendMessage does not yet support `claude` runner; use spawn() for Claude CLI");
    }
    const isLeaf = req.to === "subagent";
    const agent = isLeaf ? undefined : this.agents.get(req.to);
    if (!isLeaf && !agent) {
      throw new Error(`Unknown agent: ${req.to}`);
    }
    if (isLeaf && !req.leafContext) {
      throw new Error('sendMessage: leafContext is required when to === "subagent"');
    }
    if (isLeaf && req.sessionId) {
      throw new Error("sendMessage: leaf sessions are not resumable; omit sessionId");
    }
    if (!this.builtinRunner) {
      throw new Error("AgentRuntime: builtin runner not configured (pass `core` to constructor)");
    }
    if (req.cwd) this.validateCwd(req.cwd);

    const kind: AgentSessionKind = isLeaf ? "leaf" : "root";
    if (kind === "leaf") {
      const leafCount = [...this.runsV2.values()].filter((r) => r.kind === "leaf").length;
      if (leafCount >= LEAF_CONCURRENCY_CAP) {
        throw new Error(`Max concurrent leaf runs reached (${LEAF_CONCURRENCY_CAP})`);
      }
    }

    const runId = randomUUID();
    const sessionId = req.sessionId
      ?? (isLeaf
        ? `subagent:${runId}`
        : `peer:${req.from?.agentId ?? "transport"}:${randomUUID()}`);

    const abort = new AbortController();
    const handle: RunHandleV2 = {
      runId,
      agentId: req.to,
      kind,
      sessionId,
      startedAt: Date.now(),
      abort,
      ...(req.parentSessionId ? { parentSessionId: req.parentSessionId } : {}),
    };
    this.runsV2.set(runId, handle);

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (kind === "leaf") {
      const sec = req.timeoutSeconds ?? LEAF_DEFAULT_TIMEOUT_SEC;
      timeoutHandle = setTimeout(() => abort.abort(), sec * 1000);
      timeoutHandle.unref();
    }

    log.info("sendMessage", { runId, agentId: req.to, kind, sessionId });

    try {
      yield* this.builtinRunner.sendMessage({
        request: req,
        ...(agent ? { agent } : {}),
        kind,
        sessionId,
        runId,
        abort: abort.signal,
        onSessionReady: (session) => { handle.session = session; },
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.runsV2.delete(runId);
    }
  }

  /**
   * Push-model steer: inject a user message into an in-flight run mid-turn.
   * Replaces the legacy onSteer pull callback.
   */
  async steer(runId: string, message: string): Promise<void> {
    const handle = this.runsV2.get(runId);
    if (!handle?.session) throw new Error(`No active session for run ${runId}`);
    await handle.session.steer(message);
  }

  getStatus(runId: string): RunInfo | undefined {
    const h = this.runsV2.get(runId);
    if (!h) return undefined;
    return toRunInfo(h);
  }

  listRuns(): RunInfo[] {
    return [...this.runsV2.values()].map(toRunInfo);
  }
}

function toRunInfo(h: RunHandleV2): RunInfo {
  return {
    runId: h.runId,
    agentId: h.agentId,
    kind: h.kind,
    sessionId: h.sessionId,
    startedAt: h.startedAt,
    ...(h.parentSessionId ? { parentSessionId: h.parentSessionId } : {}),
  };
}
