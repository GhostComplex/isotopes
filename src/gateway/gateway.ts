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
// Filled in as runtime events arrive; `done` resolves at agent_end.
interface ActiveHandle {
  callbacks?: DispatchCallbacks;
  responseText: string;
  errorMessage: string | null;
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

  async function consume(sessionId: string, msg: Message, handle: ActiveHandle): Promise<void> {
    try {
      for await (const event of deps.agentRuntime.run({
        to: msg.agentId,
        sessionId,
        content: msg.content,
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
        ...(msg.extraSystemPrompt ? { extraSystemPrompt: msg.extraSystemPrompt } : {}),
      })) {
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
      log.error(`consume error for ${sessionId}: ${handle.errorMessage}`);
    } finally {
      active.delete(sessionId);
      handle.resolveDone();
    }
  }

  async function dispatch(msg: Message, callbacks?: DispatchCallbacks): Promise<DispatchResult> {
    const sessionId = await resolveSessionId(msg);

    if (active.has(sessionId)) {
      try {
        await deps.agentRuntime.steer(sessionId, msg.content);
      } catch (err) {
        log.warn(`steer failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { sessionId, state: "queued", responseText: "", errorMessage: null };
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const handle: ActiveHandle = {
      callbacks,
      responseText: "",
      errorMessage: null,
      done,
      resolveDone,
    };
    active.set(sessionId, handle);
    void consume(sessionId, msg, handle);

    await handle.done;
    return {
      sessionId,
      state: "started",
      responseText: handle.responseText,
      errorMessage: handle.errorMessage,
    };
  }

  async function abort(sessionId: string, reason?: string): Promise<void> {
    deps.agentRuntime.cancel(sessionId, reason ? { reason } : undefined);
  }

  return { dispatch, abort };
}
