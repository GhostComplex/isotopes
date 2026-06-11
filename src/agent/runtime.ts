import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import type {
  RegisteredAgent,
  RunRequest,
  RunInfo,
  ProviderConfig,
  AgentConfig,
} from "./types.js";
import { RunValidationError } from "./types.js";
import type { PiSessionDeps } from "./pi/session-factory.js";
import { PiRunner } from "./pi/runner.js";
import { ClaudeRunner } from "./adapters/claude/runner.js";
import { CopilotRunner } from "./adapters/copilot/runner.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  type AgentSession,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import {
  toAgentConfig,
  type AgentConfigFile,
  type AgentToolsConfigFile,
  type ProviderConfigFile,
} from "../config.js";
import fs from "node:fs/promises";
import {
  getAgentWorkspacePath,
} from "../utils/paths.js";
import { ensureWorkspaceStructure } from "./workspace/context.js";
import { seedWorkspaceTemplates } from "./workspace/templates.js";
import { LazyChannelContext } from "../channels/types.js";
import type { DefaultSessionStore } from "./pi/session-store.js";

const log = createLogger("runtime");

export const MAX_DEPTH = 5;
export const MAX_CHILDREN_PER_PARENT = 5;
/** Default per-run timeout when req.timeoutSeconds is absent. */
export const DEFAULT_TIMEOUT_SEC = 900;

interface RunHandle {
  runId: string;
  agentId: string;
  sessionId: string;
  depth: number;
  startedAt: number;
  abort: AbortController;
  parentSessionId?: string;
  session?: AgentSession;
  /** Sync in-turn steer registered by the runner. Returns false if the run
   *  is no longer accepting steer. Discord channel calls runtime.trySteer
   *  via this on every inbound — see gateway.trySteer. */
  steer?: SyncSteer;
  cancelReason?: string;
}

/** Synchronous in-turn steer fn. Returns true iff the message was queued into
 *  the active turn; false otherwise (run already ended, disposed, etc.).
 *  Must be synchronous so the caller can decide leader-vs-steer atomically. */
export type SyncSteer = (content: string) => boolean;

export interface AgentRuntimeOptions {
  /** Default LLM provider. */
  globalProvider?: ProviderConfig;
  /** pi extension file paths discovered from ~/.isotopes/extensions/pi/. */
  extensionPaths?: string[];
}

export interface AddAgentOptions {
  agentFile: AgentConfigFile;
  provider?: ProviderConfigFile;
  globalTools?: AgentToolsConfigFile;
  channelContext?: LazyChannelContext;
  spawnableAgentIds?: string[];
  sessionStore: DefaultSessionStore;
}

export interface AddAgentResult {
  agent: RegisteredAgent;
  /** null when the runner has no workspace (e.g. claude). */
  workspacePath: string | null;
  channelContext?: LazyChannelContext;
}

export interface Runner {
  /** Backing isotopes agent (drives getAgent / listAgents). */
  agent?(): RegisteredAgent | undefined;
  validateRequest?(req: RunRequest): void;
  resolveSessionId(req: RunRequest): Promise<string> | string;
  run(opts: {
    request: RunRequest;
    sessionId: string;
    abort: AbortSignal;
    /** Steerable session hook; ClaudeRunner doesn't call it. */
    onSession?: (session: AgentSession) => void;
    /** Register a synchronous in-turn steer function. Called once per run by
     *  runners that support steering (pi). The function returns true if the
     *  message was queued into the in-flight turn, false if the run is no
     *  longer accepting steer (already stopped, disposed, etc.). */
    registerSteer?: (steer: SyncSteer) => void;
  }): AsyncGenerator<AgentEvent>;
}

interface Entry {
  runner: Runner;
  spawnable: boolean;
}

export class AgentRuntime {
  private entries = new Map<string, Entry>();
  private runs = new Map<string, RunHandle>();
  private piGlobalProvider?: ProviderConfig;
  private piAuthStorage?: AuthStorage;
  private piModelRegistry?: ModelRegistry;
  private extensionPaths: string[] = [];

  constructor(options?: AgentRuntimeOptions) {
    const opts = options ?? {};
    if (opts.extensionPaths) this.extensionPaths = opts.extensionPaths;

    if (opts.globalProvider) {
      const creds: Record<string, { type: "api_key"; key: string }> = {};
      if (opts.globalProvider.apiKey) {
        creds[opts.globalProvider.type] = { type: "api_key", key: opts.globalProvider.apiKey };
      }
      this.piGlobalProvider = opts.globalProvider;
      this.piAuthStorage = AuthStorage.inMemory(creds);
      this.piModelRegistry = ModelRegistry.create(this.piAuthStorage);
    }
  }

  /** True iff globalProvider was passed (required for any pi-backed agent). */
  hasPiInfra(): boolean {
    return this.piGlobalProvider !== undefined;
  }

  private piDeps(): PiSessionDeps {
    if (!this.piGlobalProvider || !this.piAuthStorage || !this.piModelRegistry) {
      throw new Error("pi infra not configured (pass globalProvider to AgentRuntime)");
    }
    return {
      globalProvider: this.piGlobalProvider,
      authStorage: this.piAuthStorage,
      modelRegistry: this.piModelRegistry,
      runtime: this,
      ...(this.extensionPaths.length > 0 ? { extensionPaths: this.extensionPaths } : {}),
    };
  }

  registerRunner(
    name: string,
    runner: Runner,
    opts: { spawnable?: boolean } = {},
  ): void {
    if (this.entries.has(name)) throw new Error(`Already registered: ${name}`);
    this.entries.set(name, {
      runner,
      spawnable: opts.spawnable ?? true,
    });
  }

  hasRunner(name: string): boolean {
    return this.entries.has(name);
  }

  runnerNames(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Names advertised to other agents in spawn_agent. */
  spawnableRunnerNames(): string[] {
    const out: string[] = [];
    for (const [name, entry] of this.entries) {
      if (entry.spawnable) out.push(name);
    }
    return out;
  }

  validateCwd(cwd: string): void {
    const resolved = resolve(cwd);
    let normalized: string;
    try {
      normalized = realpathSync(resolved);
    } catch {
      normalized = normalize(resolved);
    }
    if (!existsSync(normalized)) throw new Error(`Working directory does not exist: ${cwd}`);
    if (!statSync(normalized).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
  }

  /** Single registration entry point. Branches on agent.runner. */
  async register(opts: AddAgentOptions): Promise<AddAgentResult> {
    const { agentFile, provider, globalTools } = opts;
    const agentConfig = toAgentConfig(agentFile, provider, globalTools);
    if (agentConfig.runner === "claude") return this.registerClaude(agentConfig);
    if (agentConfig.runner === "copilot") return this.registerCopilot(agentConfig);
    return this.registerPi(agentConfig, opts);
  }

  private registerClaude(agentConfig: AgentConfig): AddAgentResult {
    const agent: RegisteredAgent = {
      id: agentConfig.id,
      config: agentConfig,
      ...(agentConfig.sessionPolicy ? { sessionPolicy: agentConfig.sessionPolicy } : {}),
    };
    this.registerRunner(agentConfig.id, new ClaudeRunner(), { spawnable: agentConfig.spawnable === true });
    return { agent, workspacePath: null };
  }

  private registerCopilot(agentConfig: AgentConfig): AddAgentResult {
    const agent: RegisteredAgent = {
      id: agentConfig.id,
      config: agentConfig,
      ...(agentConfig.sessionPolicy ? { sessionPolicy: agentConfig.sessionPolicy } : {}),
    };
    this.registerRunner(agentConfig.id, new CopilotRunner(), { spawnable: agentConfig.spawnable === true });
    return { agent, workspacePath: null };
  }

  private async registerPi(
    agentConfig: AgentConfig,
    opts: AddAgentOptions,
  ): Promise<AddAgentResult> {
    const { channelContext, spawnableAgentIds, sessionStore } = opts;

    const workspacePath = getAgentWorkspacePath(agentConfig);
    await fs.mkdir(workspacePath, { recursive: true });

    await seedWorkspaceTemplates(workspacePath, agentConfig.id);
    await ensureWorkspaceStructure(workspacePath);

    const agent: RegisteredAgent = {
      id: agentConfig.id,
      config: agentConfig,
      sessionStore,
      ...(agentConfig.sessionPolicy ? { sessionPolicy: agentConfig.sessionPolicy } : {}),
      ...(spawnableAgentIds ? { spawnableAgentIds } : {}),
      ...(channelContext ? { channelContext } : {}),
    };

    const runner = new PiRunner({ agent, piDeps: this.piDeps() });
    this.registerRunner(agent.id, runner, { spawnable: agentConfig.spawnable === true });

    return {
      agent,
      workspacePath,
      ...(channelContext ? { channelContext } : {}),
    };
  }

  getAgent(id: string): RegisteredAgent | undefined {
    return this.entries.get(id)?.runner.agent?.();
  }

  listAgents(): RegisteredAgent[] {
    const out: RegisteredAgent[] = [];
    for (const entry of this.entries.values()) {
      const a = entry.runner.agent?.();
      if (a) out.push(a);
    }
    return out;
  }

  unregisterAgent(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.runner.agent?.()) return false;
    this.entries.delete(id);
    return true;
  }

  private computeDepth(parentSessionId: string | undefined): number {
    if (!parentSessionId) return 1;
    return (this.runs.get(parentSessionId)?.depth ?? 0) + 1;
  }

  private countActiveSiblings(parentSessionId: string | undefined): number {
    if (!parentSessionId) return 0;
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.parentSessionId === parentSessionId) n++;
    }
    return n;
  }

  async *run(req: RunRequest): AsyncGenerator<AgentEvent> {
    const entry = this.entries.get(req.to);
    if (!entry) throw new RunValidationError(`Unknown agent: ${req.to}`);
    entry.runner.validateRequest?.(req);
    if (req.cwd) {
      try { this.validateCwd(req.cwd); }
      catch (err) { throw new RunValidationError(err instanceof Error ? err.message : String(err)); }
    }

    const depth = this.computeDepth(req.parentSessionId);
    if (depth > MAX_DEPTH) {
      throw new RunValidationError(`Max spawn depth reached (${MAX_DEPTH})`);
    }
    const siblings = this.countActiveSiblings(req.parentSessionId);
    if (siblings >= MAX_CHILDREN_PER_PARENT) {
      throw new RunValidationError(`Max concurrent children per parent reached (${MAX_CHILDREN_PER_PARENT})`);
    }

    const runId = randomUUID();
    const sessionId = await entry.runner.resolveSessionId(req);
    if (this.runs.has(sessionId)) {
      throw new RunValidationError(`Session "${sessionId}" already has an active run`);
    }
    const abort = new AbortController();
    const handle: RunHandle = {
      runId,
      agentId: req.to,
      sessionId,
      depth,
      startedAt: Date.now(),
      abort,
      ...(req.parentSessionId ? { parentSessionId: req.parentSessionId } : {}),
    };
    this.runs.set(sessionId, handle);
    log.info("Run started", { runId, agentId: req.to, sessionId, depth });

    const sec = req.timeoutSeconds ?? DEFAULT_TIMEOUT_SEC;
    const timeoutHandle = setTimeout(() => this.cancel(sessionId, { reason: "timeout" }), sec * 1000);
    timeoutHandle.unref();

    try {
      req.onRunStart?.(sessionId);
    } catch { /* ignore */ }

    try {
      for await (const event of entry.runner.run({
        request: req,
        sessionId,
        abort: abort.signal,
        onSession: (session) => { handle.session = session; },
        registerSteer: (steerFn) => { handle.steer = steerFn; },
      })) {
        if (event.type === "tool_execution_start") {
          log.debug("Tool call", { runId, agentId: req.to, toolName: event.toolName, toolCallId: event.toolCallId });
        } else if (event.type === "tool_execution_end") {
          log.debug("Tool result", { runId, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        }
        yield event;
      }
    } finally {
      clearTimeout(timeoutHandle);
      // Consumer break → abort inner runner so no orphan SDK work.
      if (!handle.abort.signal.aborted) handle.abort.abort();
      if (handle.cancelReason && req.onCancel) {
        try { req.onCancel(handle.cancelReason); } catch { /* ignore */ }
      }
      this.runs.delete(sessionId);
      log.info("Run ended", { runId, agentId: req.to, durationMs: Date.now() - handle.startedAt });
    }
  }

  cancel(sessionId: string, opts?: { reason?: string }): boolean {
    const handle = this.runs.get(sessionId);
    if (!handle) return false;
    if (opts?.reason) handle.cancelReason = opts.reason;
    handle.abort.abort();
    log.info("Run cancelled", { sessionId, reason: opts?.reason });
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  get activeCount(): number {
    return this.runs.size;
  }

  /** Synchronous in-turn steer. Returns true if the message was queued into
   *  the active run's current turn, false if no such run exists, the runner
   *  doesn't support steer, or the run is no longer accepting steer. */
  trySteer(sessionId: string, content: string): boolean {
    return this.runs.get(sessionId)?.steer?.(content) ?? false;
  }

  getRunBySession(sessionId: string): RunInfo | undefined {
    const h = this.runs.get(sessionId);
    if (!h) return undefined;
    return toRunInfo(h);
  }

  listRuns(): RunInfo[] {
    return [...this.runs.values()].map(toRunInfo);
  }
}

function toRunInfo(h: RunHandle): RunInfo {
  return {
    runId: h.runId,
    agentId: h.agentId,
    sessionId: h.sessionId,
    startedAt: h.startedAt,
    depth: h.depth,
    ...(h.parentSessionId ? { parentSessionId: h.parentSessionId } : {}),
  };
}
