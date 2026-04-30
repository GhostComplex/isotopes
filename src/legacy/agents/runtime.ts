// AgentRuntime: single execution verb (sendMessage), agent registry,
// push-model steer, run lifecycle.

import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import type {
  AgentSessionKind,
  AgentSessionPolicy,
  RegisteredAgent,
  SendMessageRequest,
  RunInfo,
} from "./types.js";
import type { ProviderConfig } from "../../agent/types.js";
import type { HookRegistry } from "../plugins/hooks.js";
import { PiRunner } from "../../agent/runners/pi/runner.js";
import { createRootPiSession, createLeafPiSession } from "../../agent/runners/pi/session-factory.js";
import { ClaudeRunner, type ClaudeRunnerOptions } from "../../agent/runners/claude/runner.js";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import {
  type AgentSession,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

const log = createLogger("agents:runtime");

// Magic ids — reserved (cannot be registered as named agents). See #613
// for the policy decision on whether `claude` should be conditionally
// reserved when no ClaudeRunner is configured.
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

/** Caller-fixable input error. Tool handlers should surface as `[error]`
 * instead of `[failed]` so the LLM doesn't retry. */
export class SendMessageValidationError extends Error {
  readonly isValidationError = true;
  constructor(message: string) {
    super(message);
    this.name = "SendMessageValidationError";
  }
}

/**
 * Per-session listener registry: a thin pub/sub keyed by sessionId.
 * Owned by AgentRuntime as a private field; not exported because callers
 * should subscribe via runtime.on / runtime.endSession.
 */
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

  // ---------------------------------------------------------------------------
  // Per-agent pi tool registry
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Per-session event subscription — facade over SessionEventBus (defined above)
  // ---------------------------------------------------------------------------

  /** Subscribe to events for a session. Returns an unsubscribe function. */
  on(sessionId: string, listener: (event: AgentEvent) => void): () => void {
    return this.events.on(sessionId, listener);
  }

  /**
   * @internal Called by agent-run.ts to fan out events from the runner loop.
   * External callers should subscribe via on(), not emit. Listener errors are
   * logged and isolated.
   */
  emitSessionEvent(sessionId: string, event: AgentEvent): void {
    this.events.emit(sessionId, event);
  }

  /**
   * Remove all listeners for a session and free the underlying entry.
   * Intended for the session's owner to call in a `finally` block.
   *
   * **Single-owner assumption**: the bus assumes one logical flow per
   * sessionId at a time. If a session ever has multiple concurrent owners
   * (e.g. HTTP retry overlap, Discord reconnect mid-run), calling
   * endSession from one owner will tear down the other's subscription
   * too. The unsubscribe handle returned by `on()` is per-listener and
   * always safe; `endSession` is the bigger hammer.
   */
  endSession(sessionId: string): void {
    this.events.endSession(sessionId);
  }

  /** Number of active listeners for a session (mainly for tests / diagnostics). */
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

  // ---------- Agent registry ----------

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

  /**
   * Run SDK-side compaction on a specific (agent, sessionId). Used by the
   * `/compact` slash command. Returns true if compaction ran, false if
   * there wasn't enough context to compact.
   */
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
  async *sendMessage(req: SendMessageRequest): AsyncGenerator<AgentEvent> {
    const isSubagent = req.to === SUBAGENT_AGENT_ID;
    const isClaude = req.to === CLAUDE_AGENT_ID;
    const isLeaf = isSubagent || isClaude;
    const agent = isLeaf ? undefined : this.agents.get(req.to);
    if (!isLeaf && !agent) throw new SendMessageValidationError(`Unknown agent: ${req.to}`);
    if (isSubagent && !req.leafContext) {
      throw new SendMessageValidationError('sendMessage: leafContext is required when to === "subagent"');
    }
    if (isClaude && !this.claudeRunner) {
      throw new SendMessageValidationError('sendMessage: claude runner not configured (pass `claude` option to AgentRuntime)');
    }
    if (isClaude && !req.cwd) {
      throw new SendMessageValidationError('sendMessage: cwd is required when to === "claude"');
    }
    if (isLeaf && req.sessionId) {
      throw new SendMessageValidationError("sendMessage: leaf sessions are not resumable; omit sessionId");
    }
    if (!isClaude && !this.piRunner) {
      throw new SendMessageValidationError("AgentRuntime: pi runner not configured (pass `core` to constructor)");
    }
    if (req.cwd) {
      try { this.validateCwd(req.cwd); }
      catch (err) { throw new SendMessageValidationError(err instanceof Error ? err.message : String(err)); }
    }

    const kind: AgentSessionKind = isLeaf ? "leaf" : "root";
    if (kind === "leaf") {
      const leafCount = [...this.runs.values()].filter((r) => r.kind === "leaf").length;
      if (leafCount >= LEAF_CONCURRENCY_CAP) {
        throw new SendMessageValidationError(`Max concurrent leaf runs reached (${LEAF_CONCURRENCY_CAP})`);
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
    req: SendMessageRequest;
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

  // ---------- Lifecycle ----------

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
