import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentRuntime } from "../agent/runtime.js";
import type { SessionStoreManager } from "../agent/pi/session-store.js";
import type {
  AwaitResult,
  CreateSessionResult,
  DispatchResult,
  Gateway,
  Message,
  Session,
  SessionEvent,
  SessionEventListener,
} from "./types.js";
import { createLogger } from "../logging/logger.js";
import { getAgentEndMeta } from "../agent/pi/messages.js";
import { resolveAgentWorkspacePath } from "../paths.js";
import { randomUUID } from "node:crypto";

const log = createLogger("gateway");

export interface GatewayDeps {
  agentRuntime: AgentRuntime;
  sessionStoreManager: SessionStoreManager;
}

// `ready` resolves once the underlying runner has registered the run
// (i.e. the first event has arrived) so steer can safely target it.
interface ActiveHandle {
  ready: Promise<void>;
  resolveReady: () => void;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const active = new Map<string, ActiveHandle>();
  // Dedupes concurrent resolveSessionId calls so two dispatches with the same
  // sessionKey share one create instead of racing into two distinct sessions.
  const resolving = new Map<string, Promise<string>>();
  // sessionId -> external subscribers (fan-out targets for emit()).
  const listeners = new Map<string, Set<SessionEventListener>>();
  // sessionId -> unsubscribe handle for the single ingestStoreEvents subscription on this session.
  const storeUnsubscribes = new Map<string, () => void>();

  function emit(sessionId: string, event: SessionEvent): void {
    const set = listeners.get(sessionId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch (err) {
        log.warn(`subscriber threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Upstream event source #1: long-lived (one per session, survives across runs).
  async function ingestStoreEvents(agentId: string, sessionId: string): Promise<void> {
    if (storeUnsubscribes.has(sessionId)) return;
    const store = deps.sessionStoreManager.peek(agentId);
    if (!store) return;
    const unsubscribe = store.subscribe(sessionId, (update) => {
      const role = (update.message as { role?: string } | undefined)?.role;
      if (role === "user") {
        emit(sessionId, { type: "user_message", message: update.message, messageId: update.messageId });
      } else if (role === "assistant") {
        emit(sessionId, { type: "assistant_message", message: update.message, messageId: update.messageId });
      }
      // tool role messages: skip — currently delivered via assistant turn.
    });
    storeUnsubscribes.set(sessionId, unsubscribe);
  }

  async function doResolveSessionId(msg: Message): Promise<string> {
    const store = await deps.sessionStoreManager.getOrCreate(msg.agentId);
    if (msg.sessionKey) {
      const existing = await store.findByKey(msg.sessionKey);
      if (existing) return existing.id;
      const created = await store.create(msg.agentId, { key: msg.sessionKey });
      return created.id;
    }
    return (await store.create(msg.agentId)).id;
  }

  function resolveSessionId(msg: Message): Promise<string> {
    if (!msg.sessionKey) return doResolveSessionId(msg);
    const cacheKey = `${msg.agentId}::${msg.sessionKey}`;
    const pending = resolving.get(cacheKey);
    if (pending) return pending;
    const promise = doResolveSessionId(msg).finally(() => resolving.delete(cacheKey));
    resolving.set(cacheKey, promise);
    return promise;
  }

  // Upstream event source #2: short-lived (one per run). agent_end is emitted by
  // the caller's finally so failure paths (throws) also get a terminal event.
  async function ingestRunnerEvents(
    sessionId: string,
    msg: Message,
    onFirstEvent: () => void,
  ): Promise<string | null> {
    let firstSeen = false;
    let errorMessage: string | null = null;
    const cfg = deps.agentRuntime.getAgent(msg.agentId)?.config;
    const cwd = cfg ? resolveAgentWorkspacePath(cfg) : undefined;
    for await (const event of deps.agentRuntime.run({
      to: msg.agentId,
      sessionId,
      content: msg.content,
      ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
      ...(cwd ? { cwd } : {}),
      ...(msg.extraSystemPrompt ? { extraSystemPrompt: msg.extraSystemPrompt } : {}),
    })) {
      if (!firstSeen) { firstSeen = true; onFirstEvent(); }
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          emit(sessionId, { type: "text_delta", delta: ame.delta });
        }
      } else if (event.type === "tool_execution_start") {
        emit(sessionId, { type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        emit(sessionId, {
          type: "tool_result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      } else if (event.type === "turn_end") {
        emit(sessionId, { type: "turn_end" });
      } else if (event.type === "agent_end") {
        const meta = getAgentEndMeta(event.messages);
        if (meta.stopReason === "error") errorMessage = meta.errorMessage ?? "Unknown agent error";
      }
    }
    return errorMessage;
  }

  // Scheduler: owns the active-handle lifecycle for one run and guarantees a
  // terminal agent_end emit regardless of success/throw.
  async function triggerRun(sessionId: string, msg: Message, handle: ActiveHandle): Promise<void> {
    let readyResolved = false;
    let errorMessage: string | null = null;
    const markReady = () => { readyResolved = true; handle.resolveReady(); };
    try {
      errorMessage = await ingestRunnerEvents(sessionId, msg, markReady);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`triggerRun error for ${sessionId}: ${errorMessage}`);
    } finally {
      active.delete(sessionId);
      if (!readyResolved) handle.resolveReady();
      emit(sessionId, errorMessage
        ? { type: "agent_end", stopReason: "error", errorMessage }
        : { type: "agent_end", stopReason: "end" });
    }
  }

  async function dispatch(msg: Message): Promise<DispatchResult> {
    const sessionId = await resolveSessionId(msg);
    await ingestStoreEvents(msg.agentId, sessionId);

    while (true) {
      const existing = active.get(sessionId);
      if (existing) {
        await existing.ready;
        // The run may have ended while we awaited ready (finally also resolves
        // ready). If `active` no longer holds our handle, retry as a fresh run.
        if (active.get(sessionId) !== existing) continue;
        try {
          await deps.agentRuntime.steer(sessionId, msg.content);
          return { sessionId, state: "steered" };
        } catch (err) {
          if (!active.has(sessionId)) continue;
          log.warn(`steer failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          return { sessionId, state: "steered" };
        }
      }

      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });
      const handle: ActiveHandle = { ready, resolveReady };
      active.set(sessionId, handle);
      void triggerRun(sessionId, msg, handle);
      // Wait for handle.ready so a follow-up dispatch sees the active run and steers.
      await handle.ready;
      return { sessionId, state: "new_run" };
    }
  }

  async function dispatchAndWait(msg: Message): Promise<AwaitResult> {
    let responseText = "";
    let errorMessage: string | null = null;

    // Pin the sessionKey so subscribe and dispatch resolve to the same session
    // — anonymous-session dispatches otherwise resolve to distinct sessionIds.
    const pinnedMsg: Message = msg.sessionKey ? msg : { ...msg, sessionKey: randomUUID() };
    const sessionId = await resolveSessionId(pinnedMsg);
    await ingestStoreEvents(pinnedMsg.agentId, sessionId);

    const done = new Promise<void>((resolve) => {
      const unsubscribe = subscribeInternal(sessionId, (event) => {
        if (event.type === "text_delta") responseText += event.delta;
        else if (event.type === "agent_end") {
          if (event.stopReason === "error") errorMessage = event.errorMessage ?? "Unknown agent error";
          unsubscribe();
          resolve();
        }
      });
    });

    await dispatch(pinnedMsg);
    await done;
    return { responseText, errorMessage };
  }

  /** Internal: subscribe by sessionId (already resolved). */
  function subscribeInternal(sessionId: string, listener: SessionEventListener): () => void {
    let set = listeners.get(sessionId);
    if (!set) {
      set = new Set();
      listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const s = listeners.get(sessionId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) listeners.delete(sessionId);
    };
  }

  async function subscribe(
    agentId: string,
    sessionKey: string,
    listener: SessionEventListener,
  ): Promise<(() => void) | undefined> {
    const store = deps.sessionStoreManager.peek(agentId);
    if (!store) return undefined;
    const session = await store.findByKey(sessionKey);
    if (!session) return undefined;
    await ingestStoreEvents(agentId, session.id);
    return subscribeInternal(session.id, listener);
  }

  async function abort(sessionId: string, reason?: string): Promise<void> {
    deps.agentRuntime.cancel(sessionId, reason ? { reason } : undefined);
  }

  async function abortByKey(agentId: string, sessionKey: string, reason?: string): Promise<boolean> {
    const store = await deps.sessionStoreManager.getOrCreate(agentId);
    const session = await store.findByKey(sessionKey);
    if (!session) return false;
    return deps.agentRuntime.cancel(session.id, reason ? { reason } : undefined);
  }

  function agentExists(agentId: string): boolean {
    return deps.agentRuntime.getAgent(agentId)?.config !== undefined;
  }

  async function listSessions(): Promise<Session[]> {
    const out: Session[] = [];
    for (const [, store] of deps.sessionStoreManager.all()) {
      const sessions = await store.list();
      for (const s of sessions) if (s.metadata?.key) out.push(s);
    }
    return out;
  }

  async function listSessionsForAgent(agentId: string): Promise<Session[]> {
    const store = deps.sessionStoreManager.peek(agentId);
    if (!store) return [];
    return (await store.list()).filter((s) => s.metadata?.key);
  }

  async function getSession(agentId: string, sessionKey: string): Promise<Session | undefined> {
    const store = deps.sessionStoreManager.peek(agentId);
    return store ? store.findByKey(sessionKey) : undefined;
  }

  async function getMessages(agentId: string, sessionKey: string): Promise<AgentMessage[] | undefined> {
    const store = deps.sessionStoreManager.peek(agentId);
    if (!store) return undefined;
    const session = await store.findByKey(sessionKey);
    return session ? store.getMessages(session.id) : undefined;
  }

  async function createOrResumeSession(
    agentId: string,
    sessionKey?: string,
  ): Promise<CreateSessionResult> {
    const store = await deps.sessionStoreManager.getOrCreate(agentId);
    const key = sessionKey ?? randomUUID();
    if (sessionKey) {
      const existing = await store.findByKey(sessionKey);
      if (existing) return { sessionId: existing.id, sessionKey: existing.metadata?.key ?? sessionKey, resumed: true };
    }
    const created = await store.create(agentId, { key });
    return { sessionId: created.id, sessionKey: key, resumed: false };
  }

  async function deleteSession(agentId: string, sessionKey: string): Promise<boolean> {
    const store = deps.sessionStoreManager.peek(agentId);
    if (!store) return false;
    const session = await store.findByKey(sessionKey);
    if (!session) return false;
    const unsub = storeUnsubscribes.get(session.id);
    if (unsub) { unsub(); storeUnsubscribes.delete(session.id); }
    listeners.delete(session.id);
    await store.delete(session.id);
    return true;
  }

  return {
    dispatch,
    dispatchAndWait,
    abort,
    abortByKey,
    agentExists,
    listSessions,
    listSessionsForAgent,
    getSession,
    getMessages,
    subscribe,
    createOrResumeSession,
    deleteSession,
  };
}
