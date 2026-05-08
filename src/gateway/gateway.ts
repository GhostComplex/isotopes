import type { AgentRuntime } from "../agent/runtime.js";
import type { SessionStoreManager } from "../agent/runners/pi/session-store.js";
import type {
  DispatchCallbacks,
  DispatchResult,
  Gateway,
  Message,
} from "./types.js";
import { createLogger } from "../logging/logger.js";
import { getAgentEndMeta } from "../agent/runners/pi/messages.js";

const log = createLogger("gateway");

export interface GatewayDeps {
  agentRuntime: AgentRuntime;
  sessionStoreManager: SessionStoreManager;
}

// State for the dispatch driving this session's run.
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
  // sessionId → handle for the dispatch currently driving that session's run
  const active = new Map<string, ActiveHandle>();

  async function resolveSessionId(msg: Message): Promise<string> {
    const store = await deps.sessionStoreManager.getOrCreate(msg.agentId);
    if (msg.sessionKey) {
      const existing = await store.findByKey(msg.sessionKey);
      if (existing) return existing.id;
      const created = await store.create(msg.agentId, { key: msg.sessionKey });
      return created.id;
    }
    return (await store.create(msg.agentId)).id;
  }

  async function triggerRun(sessionId: string, msg: Message, handle: ActiveHandle): Promise<void> {
    let readyResolved = false;
    try {
      for await (const event of deps.agentRuntime.run({
        to: msg.agentId,
        sessionId,
        content: msg.content,
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
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
   *   `callbacks` until agent_end. Returns `state: "started"` with the final
   *   responseText.
   * - If the session already has an active run, forwards `msg.content` to the
   *   runner's native queue via `steer` and returns `state: "queued"` immediately.
   *   The steered content's output continues streaming through the **original**
   *   handle's callbacks (the first dispatcher's). The `callbacks` argument
   *   passed on a queued call is **ignored** — there is one transport sink per
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
          return { sessionId, state: "queued", responseText: "", errorMessage: null };
        } catch (err) {
          // Steer can still race with the run ending between recheck and the
          // steer call. If the run is gone, retry as fresh; otherwise the
          // failure is something else — log and return queued with no effect.
          if (!active.has(sessionId)) continue;
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`steer failed for ${sessionId}: ${errorMessage}`);
          return { sessionId, state: "queued", responseText: "", errorMessage };
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
        state: "started",
        responseText: handle.responseText,
        errorMessage: handle.errorMessage,
      };
    }
  }

  async function abort(sessionId: string, reason?: string): Promise<void> {
    deps.agentRuntime.cancel(sessionId, reason ? { reason } : undefined);
  }

  return { dispatch, abort };
}
