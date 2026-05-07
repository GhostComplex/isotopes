import type { AgentRuntime } from "../agent/runtime.js";
import type { SessionStoreManager } from "../agent/runners/pi/session-store.js";
import type { RunRequest } from "../agent/types.js";
import type { Gateway, Message, SendResult, SendAndWaitResult } from "./types.js";
import { EventBus } from "./event-bus.js";
import { PendingBuffer } from "./pending-buffer.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("gateway");

const STEER_PREFIX = "[Messages arrived while you were working]\n";

export interface GatewayDeps {
  runtime: AgentRuntime;
  sessionStoreManager: SessionStoreManager;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const events = new EventBus();
  const buffer = new PendingBuffer();

  async function resolveSessionId(msg: Message): Promise<string> {
    const store = await deps.sessionStoreManager.getOrCreate(msg.agentId);
    if (msg.sessionKey) {
      const existing = await store.findByKey(msg.sessionKey);
      if (existing) return existing.id;
      const created = await store.create(msg.agentId, { key: msg.sessionKey });
      return created.id;
    }
    const created = await store.create(msg.agentId);
    return created.id;
  }

  function buildRequest(msg: Message, sessionId: string): RunRequest {
    return {
      to: msg.agentId,
      sessionId,
      content: msg.content,
      ...(msg.cwd ? { cwd: msg.cwd } : {}),
      ...(msg.extraSystemPrompt ? { extraSystemPrompt: msg.extraSystemPrompt } : {}),
    };
  }

  function formatBufferAsSteer(messages: Message[]): string {
    const lines = messages.map((m) =>
      m.sender ? `${m.sender}: ${m.content}` : m.content,
    );
    return STEER_PREFIX + lines.join("\n");
  }

  async function consumeStream(
    sessionId: string,
    agentId: string,
    request: RunRequest,
  ): Promise<void> {
    try {
      for await (const event of deps.runtime.run(request)) {
        events.emit(sessionId, agentId, event);
        if (event.type === "turn_end") {
          const drained = buffer.drain(sessionId);
          if (drained.length > 0) {
            try {
              await deps.runtime.steer(sessionId, formatBufferAsSteer(drained));
            } catch (err) {
              log.warn(`steer failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      log.error(`stream consumer error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function send(msg: Message): Promise<SendResult> {
    const sessionId = await resolveSessionId(msg);

    if (deps.runtime.isRunning(sessionId)) {
      const queueDepth = buffer.add(sessionId, msg);
      return { state: "buffered", sessionId, queueDepth };
    }

    void consumeStream(sessionId, msg.agentId, buildRequest(msg, sessionId));
    return { state: "started", sessionId };
  }

  async function sendAndWait(msg: Message): Promise<SendAndWaitResult> {
    const sessionId = await resolveSessionId(msg);
    let responseText = "";
    const errorMessage: string | null = null;
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });

    // Subscribe before kicking the run — otherwise we race the consumer.
    const unsub = events.subscribe({ sessionId }, (event) => {
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") responseText += ame.delta;
      } else if (event.type === "agent_end") {
        resolveDone();
      }
    });

    try {
      if (deps.runtime.isRunning(sessionId)) {
        // Someone else owns the run; their agent_end (after draining our
        // buffered message via steer) is what wakes us.
        buffer.add(sessionId, msg);
      } else {
        void consumeStream(sessionId, msg.agentId, buildRequest(msg, sessionId));
      }
      await done;
    } finally {
      unsub();
    }

    return { responseText, errorMessage, sessionId };
  }

  async function abort(sessionId: string, reason?: string): Promise<void> {
    deps.runtime.cancel(sessionId, reason ? { reason } : undefined);
  }

  return {
    send,
    sendAndWait,
    events: {
      subscribe: events.subscribe.bind(events),
    },
    abort,
  };
}
