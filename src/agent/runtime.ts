import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import type {
  RegisteredAgent,
  RunRequest,
  RunInfo,
} from "./types.js";
import { RunValidationError } from "./types.js";
import type { ProviderConfig } from "./types.js";
import type { HookRegistry } from "../legacy/plugins/hooks.js";
import type { PiSessionDeps } from "./runners/pi/session-factory.js";
import { PiRunner } from "./runners/pi/runner.js";
import { ClaudeRunner } from "./runners/claude/runner.js";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import {
  type AgentSession,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import {
  toAgentConfig,
  type AgentConfigFile,
  type AgentDefaultsConfigFile,
  type SandboxConfigFile,
  type AgentToolsConfigFile,
  type ProviderConfigFile,
} from "../config.js";
import {
  ensureExplicitWorkspaceDir,
  ensureWorkspaceDir,
  resolveExplicitWorkspacePath,
} from "../paths.js";
import { ensureWorkspaceStructure } from "./workspace.js";
import { seedWorkspaceTemplates } from "../legacy/workspace/templates.js";
import { reconcileWorkspaceState } from "../legacy/workspace/state.js";
import { createAgentTools } from "../legacy/core/tools.js";
import { LazyTransportContext } from "../legacy/tools/react.js";
import { ProcessRegistry } from "../legacy/tools/exec.js";
import { SandboxExecutor } from "../legacy/sandbox/executor.js";
import type { DefaultSessionStore } from "./runners/pi/session-store.js";

const log = createLogger("agents:runtime");

/** Spawn-tree depth limit. Top-level = 1; reject when child would land > MAX_DEPTH. */
export const MAX_DEPTH = 5;
/** Concurrent in-flight children per parentSessionId. */
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
  cancelReason?: string;
}

export interface AgentRuntimeOptions {
  /** Roots within which `cwd` arguments must resolve. Empty = no restriction. */
  allowedWorkspaceRoots?: string[];
  /** Default LLM provider. */
  globalProvider?: ProviderConfig;
  /** Plugin hooks to fire around tool execution. */
  hooks?: HookRegistry;
}

export interface AddAgentOptions {
  agentFile: AgentConfigFile;
  agentDefaults?: AgentDefaultsConfigFile;
  provider?: ProviderConfigFile;
  globalTools?: AgentToolsConfigFile;
  sandbox?: SandboxConfigFile;
  sandboxExecutor?: SandboxExecutor;
  transportContext?: LazyTransportContext;
  spawnableAgentIds?: string[];
  sessionStore: DefaultSessionStore;
}

export interface AddAgentResult {
  agent: RegisteredAgent;
  /** null when the runner has no workspace (e.g. claude). */
  workspacePath: string | null;
  tools: AgentTool[];
  processRegistry: ProcessRegistry;
  transportContext?: LazyTransportContext;
}

/** Per-session pub/sub keyed by sessionId. Private to AgentRuntime —
 * subscribe via runtime.on / endSession. */
class SessionEventBus {
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  on(sessionId: string, listener: (event: AgentEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  emit(sessionId: string, event: AgentEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (err) {
        log.warn("Session event listener threw", err);
      }
    }
  }

  endSession(sessionId: string): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    set.clear();
    this.listeners.delete(sessionId);
  }

  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
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
  }): AsyncGenerator<AgentEvent>;
}

interface Entry {
  runner: Runner;
  spawnable: boolean;
}

export class AgentRuntime {
  private allowedRoots: string[];
  private entries = new Map<string, Entry>();
  private runs = new Map<string, RunHandle>();
  private toolRegistries = new Map<string, Map<string, AgentTool>>();
  private piGlobalProvider?: ProviderConfig;
  private piAuthStorage?: AuthStorage;
  private piModelRegistry?: ModelRegistry;
  private events = new SessionEventBus();
  private hooks?: HookRegistry;

  constructor(options?: AgentRuntimeOptions) {
    const opts = options ?? {};
    this.allowedRoots = opts.allowedWorkspaceRoots ?? [];
    if (opts.hooks) this.hooks = opts.hooks;

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
      getAgentTools: (id) => this.getAgentTools(id),
      ...(this.hooks ? { hooks: this.hooks } : {}),
    };
  }

  /** Register a runner under a name. The runner's agent (if any) becomes
   * visible via getAgent / listAgents. */
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

  /** Names of all registered entries. */
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

  setAgentTools(agentId: string, tools: Iterable<AgentTool>): void {
    const map = new Map<string, AgentTool>();
    for (const t of tools) map.set(t.name, t);
    this.toolRegistries.set(agentId, map);
  }

  clearAgentTools(agentId: string): void {
    this.toolRegistries.delete(agentId);
  }

  getAgentTools(agentId: string): AgentTool[] {
    const map = this.toolRegistries.get(agentId);
    return map ? Array.from(map.values()) : [];
  }

  on(sessionId: string, listener: (event: AgentEvent) => void): () => void {
    return this.events.on(sessionId, listener);
  }

  /** @internal — runtime auto-fans on yield; external callers use on(). */
  emitSessionEvent(sessionId: string, event: AgentEvent): void {
    this.events.emit(sessionId, event);
  }

  /** Drop all listeners for a session. Tears down concurrent subscriptions. */
  endSession(sessionId: string): void {
    this.events.endSession(sessionId);
  }

  sessionListenerCount(sessionId: string): number {
    return this.events.listenerCount(sessionId);
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
      if (!isAllowed) throw new Error(`Working directory outside allowed workspaces: ${cwd}`);
    }
  }

  /** Single registration entry point. Branches on agent.runner. */
  async register(opts: AddAgentOptions): Promise<AddAgentResult> {
    const { agentFile, agentDefaults, provider, globalTools, sandbox } = opts;
    const agentConfig = toAgentConfig(agentFile, agentDefaults, provider, globalTools, sandbox);
    return agentConfig.runner === "claude"
      ? this.registerClaude(agentConfig)
      : this.registerPi(agentConfig, opts);
  }

  private registerClaude(agentConfig: import("./types.js").AgentConfig): AddAgentResult {
    const agent: RegisteredAgent = {
      id: agentConfig.id,
      config: agentConfig,
      capabilities: { tools: [], canBeAddressed: true },
      ...(agentConfig.sessionPolicy ? { sessionPolicy: agentConfig.sessionPolicy } : {}),
    };
    this.registerRunner(agentConfig.id, new ClaudeRunner(), { spawnable: agentConfig.spawnable === true });
    log.info(`Added agent: ${agent.id} (runner: claude)`);
    return { agent, workspacePath: null, processRegistry: new ProcessRegistry(), tools: [] };
  }

  private async registerPi(
    agentConfig: import("./types.js").AgentConfig,
    opts: AddAgentOptions,
  ): Promise<AddAgentResult> {
    const { agentFile, sandboxExecutor, transportContext, spawnableAgentIds, sessionStore } = opts;

    let workspacePath: string;
    if (agentFile.workspace) {
      const resolved = resolveExplicitWorkspacePath(agentFile.workspace);
      workspacePath = await ensureExplicitWorkspaceDir(resolved);
      log.info(`Using explicit workspace for ${agentConfig.id}: ${workspacePath}`);
    } else {
      workspacePath = await ensureWorkspaceDir(agentConfig.id);
    }

    const seededFiles = await seedWorkspaceTemplates(workspacePath, agentConfig.id);
    if (seededFiles.length > 0) {
      log.info(`Seeded ${seededFiles.length} template file(s) for ${agentConfig.id}: ${seededFiles.join(", ")}`);
    }

    await reconcileWorkspaceState(workspacePath);
    await ensureWorkspaceStructure(workspacePath);

    const processRegistry = new ProcessRegistry();
    const tools: AgentTool[] = createAgentTools({
      workspacePath,
      settings: agentConfig.toolSettings,
      parentAgentId: agentConfig.id,
      agentId: agentConfig.id,
      processRegistry,
      sandboxExecutor,
      agentSandboxConfig: agentConfig.sandbox,
      allowedWorkspaces: agentFile.allowedWorkspaces ?? [],
      transportContext,
      runtime: this,
      ...(spawnableAgentIds ? { spawnableAgentIds } : {}),
    });

    if (this.hooks) {
      await this.hooks.emit("before_agent_start", { agentId: agentConfig.id });
    }

    const agent: RegisteredAgent = {
      id: agentConfig.id,
      config: agentConfig,
      sessionStore,
      capabilities: { tools: tools.map((t) => t.name), canBeAddressed: true },
      ...(agentConfig.sessionPolicy ? { sessionPolicy: agentConfig.sessionPolicy } : {}),
    };

    this.setAgentTools(agent.id, tools);
    const runner = new PiRunner({ agent, piDeps: this.piDeps() });
    this.registerRunner(agent.id, runner, { spawnable: agentConfig.spawnable === true });

    log.info(`Added agent: ${agent.id} (runner: pi, workspace: ${workspacePath}, tools: ${tools.length})`);

    return {
      agent,
      workspacePath,
      processRegistry,
      tools,
      ...(transportContext ? { transportContext } : {}),
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
    this.toolRegistries.delete(id);
    this.entries.delete(id);
    return true;
  }

  /** Compute spawn-tree depth: parent.depth + 1, or 1 for top-level. */
  private computeDepth(parentSessionId: string | undefined): number {
    if (!parentSessionId) return 1;
    for (const r of this.runs.values()) {
      if (r.sessionId === parentSessionId) return r.depth + 1;
    }
    return 1;
  }

  /** Count active sibling runs sharing the same parentSessionId. */
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

    const sec = req.timeoutSeconds ?? DEFAULT_TIMEOUT_SEC;
    const timeoutHandle = setTimeout(() => this.cancel(sessionId, { reason: "timeout" }), sec * 1000);
    timeoutHandle.unref();

    log.info("run", { runId, agentId: req.to, sessionId, depth });

    try {
      req.onRunStart?.(sessionId);
    } catch (err) {
      log.warn("onRunStart callback threw", { runId, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      // Auto fan-out + debug-log so consumers stay uniform.
      for await (const event of entry.runner.run({
        request: req,
        sessionId,
        abort: abort.signal,
        onSession: (session) => { handle.session = session; },
      })) {
        this.emitSessionEvent(sessionId, event);
        if (event.type === "tool_execution_start") {
          log.debug("tool_call", { runId, sessionId, agentId: req.to, toolName: event.toolName, id: event.toolCallId });
        } else if (event.type === "tool_execution_end") {
          log.debug("tool_result", { runId, sessionId, id: event.toolCallId });
        }
        yield event;
      }
    } finally {
      clearTimeout(timeoutHandle);
      // Consumer break → abort inner runner so no orphan SDK work.
      if (!handle.abort.signal.aborted) handle.abort.abort();
      if (handle.cancelReason && req.onCancel) {
        try { req.onCancel(handle.cancelReason); } catch (err) {
          log.warn("onCancel callback threw", { runId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.runs.delete(sessionId);
    }
  }

  /** Cancel an in-flight run by sessionId. */
  cancel(sessionId: string, opts?: { reason?: string }): boolean {
    const handle = this.runs.get(sessionId);
    if (!handle) return false;
    if (opts?.reason) handle.cancelReason = opts.reason;
    log.info("Cancelling run", { sessionId, runId: handle.runId, agentId: handle.agentId, reason: opts?.reason });
    handle.abort.abort();
    return true;
  }

  /** True iff there's an active run for this sessionId. */
  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  get activeCount(): number {
    return this.runs.size;
  }

  cancelAll(): void {
    for (const sessionId of [...this.runs.keys()]) this.cancel(sessionId);
  }

  /** Push-model steer — inject a user message into an in-flight run mid-turn. */
  async steer(sessionId: string, message: string): Promise<void> {
    const handle = this.runs.get(sessionId);
    if (!handle?.session) throw new Error(`No active session for "${sessionId}"`);
    await handle.session.steer(message);
  }

  /** Look up the active run for a sessionId. */
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
