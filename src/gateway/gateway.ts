import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentRuntime } from "../agent/runtime.js";
import type { SessionStoreManager } from "../agent/pi/session-store.js";
import type {
  CreateSessionResult,
  DispatchCallbacks,
  DispatchResult,
  Gateway,
  Message,
  Session,
  TranscriptListener,
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
// `done` resolves at agent_end; it never rejects — runner errors are
// captured into `errorMessage` and surfaced via DispatchResult.
interface ActiveHandle {
  callbacks?: DispatchCallbacks;
  responseText: string;
  errorMessage: string | null;
  ready: Promise<void>;
  resolveReady: () => void;
  done: Promise<void>;
  resolveDone: () => void;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const active = new Map<string, ActiveHandle>();
  // Dedupes concurrent resolveSessionId calls so two dispatches with the same
  // sessionKey share one create instead of racing into two distinct sessions.
  const resolving = new Map<string, Promise<string>>();

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

  async function triggerRun(sessionId: string, msg: Message, handle: ActiveHandle): Promise<void> {
    let readyResolved = false;
    const cfg = deps.agentRuntime.getAgent(msg.agentId)?.config;
    const cwd = cfg ? resolveAgentWorkspacePath(cfg) : undefined;
    try {
      for await (const event of deps.agentRuntime.run({
        to: msg.agentId,
        sessionId,
        content: msg.content,
        ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
        ...(cwd ? { cwd } : {}),
        ...(msg.extraSystemPrompt ? { extraSystemPrompt: msg.extraSystemPrompt } : {}),
      })) {
        if (!readyResolved) {
          readyResolved = true;
          handle.resolveReady();
        }
        if (event.type === "message_update") {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            handle.responseText += ame.delta;
            handle.callbacks?.onTextDelta?.(ame.delta);
          }
        } else if (event.type === "tool_execution_start") {
          handle.callbacks?.onToolStart?.({ id: event.toolCallId, name: event.toolName, args: event.args });
        } else if (event.type === "tool_execution_end") {
          handle.callbacks?.onToolEnd?.({ id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError });
        } else if (event.type === "turn_end") {
          handle.callbacks?.onTurnEnd?.();
        } else if (event.type === "agent_end") {
          const meta = getAgentEndMeta(event.messages);
          if (meta.stopReason === "error") handle.errorMessage = meta.errorMessage ?? "Unknown agent error";
        }
      }
    } catch (err) {
      handle.errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`triggerRun error for ${sessionId}: ${handle.errorMessage}`);
    } finally {
      active.delete(sessionId);
      if (!readyResolved) handle.resolveReady();
      handle.resolveDone();
    }
  }

  /**
   * Dispatch a message to an agent.
   *
   * - If the session has no active run, starts one and streams events through
   *   `callbacks` until agent_end. Returns `state: "new_run"` with the final
   *   responseText.
   * - If the session already has an active run, forwards `msg.content` to the
   *   runner's native queue via `steer` and returns `state: "steered"` immediately.
   *   The steered content's output continues streaming through the **original**
   *   handle's callbacks (the first dispatcher's). The `callbacks` argument
   *   passed on a steered call is **ignored** — there is one channel sink per
   *   session, owned by whoever started the run.
   */
  async function dispatch(msg: Message, callbacks?: DispatchCallbacks): Promise<DispatchResult> {
    const sessionId = await resolveSessionId(msg);

    // Loop to handle the case where the active run ends between when we
    // observe it and when we try to steer — fall through to start a fresh run.
    while (true) {
      const existing = active.get(sessionId);
      if (existing) {
        await existing.ready;
        // The run may have ended while we awaited ready (finally also resolves
        // ready). If `active` no longer holds our handle, retry as a fresh run.
        if (active.get(sessionId) !== existing) continue;
        try {
          await deps.agentRuntime.steer(sessionId, msg.content);
          return { sessionId, state: "steered", responseText: "", errorMessage: null };
        } catch (err) {
          // Steer can still race with the run ending between recheck and the
          // steer call. If the run is gone, retry as fresh; otherwise the
          // failure is something else — log and return steered with no effect.
          if (!active.has(sessionId)) continue;
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`steer failed for ${sessionId}: ${errorMessage}`);
          return { sessionId, state: "steered", responseText: "", errorMessage };
        }
      }

      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => { resolveDone = r; });
      const handle: ActiveHandle = {
        callbacks,
        responseText: "",
        errorMessage: null,
        ready,
        resolveReady,
        done,
        resolveDone,
      };
      active.set(sessionId, handle);
      void triggerRun(sessionId, msg, handle);

      await handle.done;
      return {
        sessionId,
        state: "new_run",
        responseText: handle.responseText,
        errorMessage: handle.errorMessage,
      };
    }
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

  async function subscribeMessages(
    agentId: string,
    sessionKey: string,
    listener: TranscriptListener,
  ): Promise<(() => void) | undefined> {
    const store = deps.sessionStoreManager.peek(agentId);
    if (!store) return undefined;
    const session = await store.findByKey(sessionKey);
    if (!session) return undefined;
    return store.subscribe(session.id, listener);
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
    await store.delete(session.id);
    return true;
  }

  return {
    dispatch,
    abort,
    abortByKey,
    agentExists,
    listSessions,
    listSessionsForAgent,
    getSession,
    getMessages,
    subscribeMessages,
    createOrResumeSession,
    deleteSession,
  };
}
