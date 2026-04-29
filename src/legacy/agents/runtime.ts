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
import type { PiMonoCore } from "../core/pi-mono.js";
import { BuiltinRunner } from "./runners/builtin.js";
import { ClaudeRunner, type ClaudeRunnerOptions } from "./runners/claude.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

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
  /** Required to drive any builtin (in-process) agent loops. */
  core?: PiMonoCore;
  /** When supplied, exposes `to: "claude"` as a leaf target via Claude CLI. */
  claude?: ClaudeRunnerOptions;
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

export class AgentRuntime {
  private allowedRoots: string[];
  private builtinRunner?: BuiltinRunner;
  private claudeRunner?: ClaudeRunner;
  private runs = new Map<string, RunHandle>();
  private agents = new Map<string, RegisteredAgent>();

  constructor(options?: AgentRuntimeOptions) {
    const opts = options ?? {};
    this.allowedRoots = opts.allowedWorkspaceRoots ?? [];
    if (opts.core) this.builtinRunner = new BuiltinRunner(opts.core);
    if (opts.claude) this.claudeRunner = new ClaudeRunner(opts.claude);
  }

  hasBuiltinRunner(): boolean {
    return this.builtinRunner !== undefined;
  }

  hasClaudeRunner(): boolean {
    return this.claudeRunner !== undefined;
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
    return this.agents.delete(id);
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
    if (!isClaude && !this.builtinRunner) {
      throw new SendMessageValidationError("AgentRuntime: builtin runner not configured (pass `core` to constructor)");
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
        yield* this.claudeRunner!.sendMessage({
          request: req,
          runId,
          abort: abort.signal,
        });
      } else {
        yield* this.builtinRunner!.sendMessage({
          request: req,
          ...(agent ? { agent } : {}),
          kind,
          sessionId,
          runId,
          abort: abort.signal,
          onSessionReady: (session) => { handle.session = session; },
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
