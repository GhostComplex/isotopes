// AgentRuntime: single execution verb (sendMessage), agent registry,
// push-model steer, run lifecycle.

import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { createLogger } from "../logging/logger.js";
import type {
  AgentSessionKind,
  AgentSessionPolicy,
  RegisteredAgent,
  RunRequest,
  RunInfo,
} from "./types.js";
import type { ProviderConfig } from "./types.js";
import type { HookRegistry } from "../legacy/plugins/hooks.js";
import { PiRunner } from "./runners/pi/runner.js";
import { createRootPiSession, createLeafPiSession } from "./runners/pi/session-factory.js";
import { ClaudeRunner, type ClaudeRunnerOptions } from "./runners/claude/runner.js";
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
  type CompactionConfigFile,
  type SandboxConfigFile,
  type AgentToolsConfigFile,
  type ProviderConfigFile,
  type SpawningConfigFile,
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
import { SandboxExecutor, SandboxFs, shouldSandbox } from "../legacy/sandbox/index.js";
import type { DefaultSessionStore } from "../legacy/core/session-store.js";

const log = createLogger("agents:runtime");

// Reserved magic ids — cannot be registered as named agents. See #613 for
// the policy decision on whether `claude` should be conditionally reserved.
export const SUBAGENT_AGENT_ID = "subagent";
export const CLAUDE_AGENT_ID = "claude";
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set([SUBAGENT_AGENT_ID, CLAUDE_AGENT_ID]);

export const LEAF_CONCURRENCY_CAP = 5;
export const LEAF_DEFAULT_TIMEOUT_SEC = 900;

interface RunHandle {
  runId: string;
  agentId: string;
  kind: AgentSessionKind;
  sessionId: string;
  startedAt: number;
  abort: AbortController;
  parentSessionId?: string;
  session?: AgentSession;
  cancelReason?: string;
}

export interface AgentRuntimeOptions {
  /** Roots within which `cwd` arguments must resolve. Empty = no restriction. */
  allowedWorkspaceRoots?: string[];
  /** Single global LLM provider — required for the pi runner. */
  globalProvider?: ProviderConfig;
  /** When supplied, exposes `to: "claude"` as a leaf target via Claude CLI. */
  claude?: ClaudeRunnerOptions;
  /** Plugin hooks to fire around tool execution. */
  hooks?: HookRegistry;
}

export interface AddAgentOptions {
  agentFile: AgentConfigFile;
  agentDefaults?: AgentDefaultsConfigFile;
  provider?: ProviderConfigFile;
  globalTools?: AgentToolsConfigFile;
  compaction?: CompactionConfigFile;
  sandbox?: SandboxConfigFile;
  spawning?: SpawningConfigFile;
  sandboxExecutor?: SandboxExecutor;
  transportContext?: LazyTransportContext;
  spawnableAgentIds?: string[];
  sessionStore: DefaultSessionStore;
}

export interface AddAgentResult {
  agent: RegisteredAgent;
  workspacePath: string;
  tools: AgentTool[];
  processRegistry: ProcessRegistry;
  transportContext?: LazyTransportContext;
}

/** Caller-fixable input error. Tool handlers should surface as `[error]`
 * instead of `[failed]` so the LLM doesn't retry. */
export class RunValidationError extends Error {
  readonly isValidationError = true;
  constructor(message: string) {
    super(message);
    this.name = "RunValidationError";
  }
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

export class AgentRuntime {
  private allowedRoots: string[];
  private piRunner?: PiRunner;
  private claudeRunner?: ClaudeRunner;
  private runs = new Map<string, RunHandle>();
  private agents = new Map<string, RegisteredAgent>();
  private events = new SessionEventBus();
  private piToolRegistries = new Map<string, Map<string, AgentTool>>();
  private piGlobalProvider?: ProviderConfig;
  private piAuthStorage?: AuthStorage;
  private piModelRegistry?: ModelRegistry;
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
      this.piRunner = new PiRunner();
    }

    if (opts.claude) this.claudeRunner = new ClaudeRunner(opts.claude);
  }

  hasPiRunner(): boolean {
    return this.piRunner !== undefined;
  }

  hasClaudeRunner(): boolean {
    return this.claudeRunner !== undefined;
  }


  setAgentTools(agentId: string, tools: Iterable<AgentTool>): void {
    const map = new Map<string, AgentTool>();
    for (const t of tools) {
      map.set(t.name, t);
    }
    this.piToolRegistries.set(agentId, map);
  }

  clearAgentTools(agentId: string): void {
    this.piToolRegistries.delete(agentId);
  }

  getAgentTools(agentId: string): AgentTool[] {
    const map = this.piToolRegistries.get(agentId);
    return map ? Array.from(map.values()) : [];
  }


  on(sessionId: string, listener: (event: AgentEvent) => void): () => void {
    return this.events.on(sessionId, listener);
  }

  /** @internal Called by run-adapter to fan out events. External callers
   * should subscribe via on(), not emit. */
  emitSessionEvent(sessionId: string, event: AgentEvent): void {
    this.events.emit(sessionId, event);
  }

  /**
   * Drop all listeners for a session. Single-owner: if a session ever
   * has multiple concurrent owners (HTTP retry overlap, Discord
   * reconnect mid-run), this tears down their subscriptions too. Use
   * the per-listener unsubscribe handle from on() if that matters.
   */
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


  registerAgent(agent: RegisteredAgent): void {
    if (RESERVED_AGENT_IDS.has(agent.id)) {
      throw new Error(`Cannot register agent with reserved magic id: ${agent.id}`);
    }
    if (this.agents.has(agent.id)) throw new Error(`Agent already registered: ${agent.id}`);
    this.agents.set(agent.id, agent);
    log.debug(`Registered agent: ${agent.id}`);
  }

  unregisterAgent(id: string): boolean {
    this.piToolRegistries.delete(id);
    return this.agents.delete(id);
  }

  /** Workspace prep + tool creation + registry insert in one call. */
  async addAgent(opts: AddAgentOptions): Promise<AddAgentResult> {
    const { agentFile, agentDefaults, provider, globalTools, compaction, sandbox,
      spawning, sandboxExecutor, transportContext, spawnableAgentIds, sessionStore } = opts;

    const agentConfig = toAgentConfig(agentFile, agentDefaults, provider, globalTools, compaction, sandbox);

    let workspacePath: string;
    if (agentFile.workspace) {
      const resolved = resolveExplicitWorkspacePath(agentFile.workspace);
      workspacePath = await ensureExplicitWorkspaceDir(resolved);
      log.info(`Using explicit workspace for ${agentConfig.id}: ${workspacePath}`);
    } else {
      workspacePath = await ensureWorkspaceDir(agentConfig.id);
    }

    const seededFiles = await seedWorkspaceTemplates(workspacePath);
    if (seededFiles.length > 0) {
      log.info(`Seeded ${seededFiles.length} template file(s) for ${agentConfig.id}: ${seededFiles.join(", ")}`);
    }

    await reconcileWorkspaceState(workspacePath);
    await ensureWorkspaceStructure(workspacePath);

    const isSandboxed = !!(sandboxExecutor && agentConfig.sandbox && shouldSandbox(agentConfig.sandbox, false));
    const fsImpl = isSandboxed ? new SandboxFs(sandboxExecutor!, agentConfig.id) : nodeFs;

    const spawningEnabled = spawning?.enabled === true && !isSandboxed;
    if (spawning?.enabled === true && isSandboxed) {
      log.warn(`Spawning tools disabled for ${agentConfig.id}: sandbox is active and child runners cannot be confined.`);
    }

    const processRegistry = new ProcessRegistry();
    const tools: AgentTool[] = createAgentTools({
      workspacePath,
      settings: agentConfig.toolSettings,
      sendMessageEnabled: spawningEnabled,
      codingMode: agentConfig.codingMode,
      fsImpl,
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
    this.registerAgent(agent);

    log.info(`Added agent: ${agent.id} (workspace: ${workspacePath}, tools: ${tools.length})`);

    return {
      agent,
      workspacePath,
      processRegistry,
      tools,
      ...(transportContext ? { transportContext } : {}),
    };
  }

  /** SDK-side compaction (used by /compact). Returns false if context is
   * too small to bother compacting. */
  async compactSession(agentId: string, sessionId: string): Promise<boolean> {
    if (!this.piGlobalProvider || !this.piAuthStorage || !this.piModelRegistry) {
      throw new Error("compactSession requires pi runner (globalProvider)");
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const session = await createRootPiSession(
      {
        globalProvider: this.piGlobalProvider,
        authStorage: this.piAuthStorage,
        modelRegistry: this.piModelRegistry,
        getAgentTools: (id) => this.getAgentTools(id),
        ...(this.hooks ? { hooks: this.hooks } : {}),
      },
      { agent, sessionId },
    );
    try {
      const compacted = await session.compact();
      return !!compacted;
    } finally {
      session.dispose();
    }
  }

  getAgent(id: string): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  listAgents(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  /** `to`: "subagent" (leaf, needs leafContext) | "claude" (leaf, needs cwd)
   * | registered-id (root). Yields SDK AgentEvent. */
  async *run(req: RunRequest): AsyncGenerator<AgentEvent> {
    const isSubagent = req.to === SUBAGENT_AGENT_ID;
    const isClaude = req.to === CLAUDE_AGENT_ID;
    const isLeaf = isSubagent || isClaude;
    const agent = isLeaf ? undefined : this.agents.get(req.to);
    if (!isLeaf && !agent) throw new RunValidationError(`Unknown agent: ${req.to}`);
    if (isSubagent && !req.leafContext) {
      throw new RunValidationError('run: leafContext is required when to === "subagent"');
    }
    if (isClaude && !this.claudeRunner) {
      throw new RunValidationError('run: claude runner not configured (pass `claude` option to AgentRuntime)');
    }
    if (isClaude && !req.cwd) {
      throw new RunValidationError('run: cwd is required when to === "claude"');
    }
    if (isLeaf && req.sessionId) {
      throw new RunValidationError("run: leaf sessions are not resumable; omit sessionId");
    }
    if (!isClaude && !this.piRunner) {
      throw new RunValidationError("AgentRuntime: pi runner not configured (pass `core` to constructor)");
    }
    if (req.cwd) {
      try { this.validateCwd(req.cwd); }
      catch (err) { throw new RunValidationError(err instanceof Error ? err.message : String(err)); }
    }

    const kind: AgentSessionKind = isLeaf ? "leaf" : "root";
    if (kind === "leaf") {
      const leafCount = [...this.runs.values()].filter((r) => r.kind === "leaf").length;
      if (leafCount >= LEAF_CONCURRENCY_CAP) {
        throw new RunValidationError(`Max concurrent leaf runs reached (${LEAF_CONCURRENCY_CAP})`);
      }
    }

    const runId = randomUUID();

    let sessionId: string;
    if (req.sessionId) {
      sessionId = req.sessionId;
    } else if (isClaude) {
      sessionId = `${CLAUDE_AGENT_ID}:${runId}`;
    } else if (isSubagent) {
      sessionId = `${SUBAGENT_AGENT_ID}:${runId}`;
    } else {
      const policy: AgentSessionPolicy = agent!.sessionPolicy ?? "parent-reuse";
      const fromId = req.from?.agentId ?? "transport";
      const suffix = policy === "parent-reuse" && req.parentSessionId
        ? req.parentSessionId
        : randomUUID();
      const sessionKey = `peer:${fromId}:${suffix}`;
      const existing = await agent!.sessionStore.findByKey(sessionKey);
      if (existing) {
        sessionId = existing.id;
      } else {
        const session = await agent!.sessionStore.create(agent!.id, { key: sessionKey });
        sessionId = session.id;
        log.debug("Created peer session", { target: agent!.id, key: sessionKey, sessionId });
      }
    }

    const abort = new AbortController();
    const handle: RunHandle = {
      runId,
      agentId: req.to,
      kind,
      sessionId,
      startedAt: Date.now(),
      abort,
      ...(req.parentSessionId ? { parentSessionId: req.parentSessionId } : {}),
    };
    this.runs.set(runId, handle);

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (kind === "leaf") {
      const sec = req.timeoutSeconds ?? LEAF_DEFAULT_TIMEOUT_SEC;
      timeoutHandle = setTimeout(() => this.cancel(runId, { reason: "timeout" }), sec * 1000);
      timeoutHandle.unref();
    }

    log.info("sendMessage", { runId, agentId: req.to, kind, sessionId });

    try {
      req.onRunStart?.(runId);
    } catch (err) {
      log.warn("onRunStart callback threw", { runId, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      if (isClaude) {
        yield* this.claudeRunner!.run({
          request: req,
          runId,
          abort: abort.signal,
        });
      } else {
        const session = await this.buildPiSession({ kind, agent, sessionId, runId, req });
        handle.session = session;
        log.info("sendMessage runner", { runId, kind, agentId: req.to });
        yield* this.piRunner!.run({
          session,
          content: req.content,
          abort: abort.signal,
        });
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Consumer break → abort inner runner so no orphan SDK work.
      if (!handle.abort.signal.aborted) handle.abort.abort();
      if (handle.cancelReason && req.onCancel) {
        try { req.onCancel(handle.cancelReason); } catch (err) {
          log.warn("onCancel callback threw", { runId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.runs.delete(runId);
    }
  }

  private async buildPiSession(opts: {
    kind: AgentSessionKind;
    agent?: RegisteredAgent;
    sessionId: string;
    runId: string;
    req: RunRequest;
  }): Promise<AgentSession> {
    const piDeps = {
      globalProvider: this.piGlobalProvider!,
      authStorage: this.piAuthStorage!,
      modelRegistry: this.piModelRegistry!,
      getAgentTools: (id: string) => this.getAgentTools(id),
      ...(this.hooks ? { hooks: this.hooks } : {}),
    };
    if (opts.kind === "root") {
      return createRootPiSession(piDeps, {
        agent: opts.agent!,
        sessionId: opts.sessionId,
        ...(opts.req.cwd ? { cwd: opts.req.cwd } : {}),
      });
    }
    return createLeafPiSession(piDeps, {
      leafContext: opts.req.leafContext!,
      runId: opts.runId,
      content: opts.req.content,
    });
  }


  cancel(runId: string, opts?: { reason?: string }): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    if (opts?.reason) handle.cancelReason = opts.reason;
    log.info("Cancelling run", { runId, agentId: handle.agentId, reason: opts?.reason });
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
    for (const runId of [...this.runs.keys()]) this.cancel(runId);
  }

  /** Push-model steer — inject a user message into an in-flight run mid-turn. */
  async steer(runId: string, message: string): Promise<void> {
    const handle = this.runs.get(runId);
    if (!handle?.session) throw new Error(`No active session for run ${runId}`);
    await handle.session.steer(message);
  }

  getStatus(runId: string): RunInfo | undefined {
    const h = this.runs.get(runId);
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
    kind: h.kind,
    sessionId: h.sessionId,
    startedAt: h.startedAt,
    ...(h.parentSessionId ? { parentSessionId: h.parentSessionId } : {}),
  };
}
