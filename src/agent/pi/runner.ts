import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import type { SyncSteer } from "../runtime.js";
import type { RegisteredAgent, RunRequest } from "../types.js";
import { createPiSession, type PiSessionDeps } from "./session-factory.js";

const log = createLogger("pi-runner");

export interface PiRunnerOptions {
  agent: RegisteredAgent;
  piDeps: PiSessionDeps;
}

/** Runs a pi session for an agent. registerPi guarantees agent.sessionStore. */
export class PiRunner {
  constructor(private opts: PiRunnerOptions) {
    if (!opts.agent.sessionStore) {
      throw new Error(`PiRunner: agent ${opts.agent.id} has no sessionStore`);
    }
  }

  agent(): RegisteredAgent {
    return this.opts.agent;
  }

  async resolveSessionId(req: RunRequest): Promise<string> {
    if (req.sessionId) return req.sessionId;
    const store = this.opts.agent.sessionStore!;
    const policy = this.opts.agent.sessionPolicy ?? "parent-reuse";
    const fromId = req.from?.agentId ?? "channel";
    const suffix = policy === "parent-reuse" && req.parentSessionId
      ? req.parentSessionId
      : randomUUID();
    const sessionKey = `peer:${fromId}:${suffix}`;
    const existing = await store.findByKey(sessionKey);
    if (existing) return existing.id;
    const created = await store.create(this.opts.agent.id, { key: sessionKey });
    return created.id;
  }

  async *run(opts: {
    request: RunRequest;
    sessionId: string;
    abort: AbortSignal;
    onSession?: (session: AgentSession) => void;
    registerSteer?: (steer: SyncSteer) => void;
  }): AsyncGenerator<AgentEvent> {
    const { request, sessionId, abort, onSession, registerSteer } = opts;
    const session = await createPiSession(this.opts.piDeps, {
      agent: this.opts.agent,
      sessionId,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.extraSystemPrompt ? { extraSystemPrompt: request.extraSystemPrompt } : {}),
    });
    onSession?.(session);
    registerSteer?.(buildSyncSteer(session));
    const content = request.cwd && request.from
      ? `[Caller working directory: ${request.cwd}]\n\n${request.content}`
      : request.content;
    try {
      yield* streamPiSession(session, content, abort, request.images);
    } finally {
      session.dispose();
    }
  }
}

/** Build a sync in-turn steer fn around an AgentSession.
 *  Returns true iff the agent is currently streaming (so the steeringQueue
 *  will be drained at the next turn boundary). When false, the caller falls
 *  back to enqueueing a new run.
 *
 *  The check + enqueue are synchronous and therefore atomic relative to the
 *  JS event loop: the agent-loop cannot interleave between the isStreaming
 *  read and the agent.steer call. This is what closes the race window where
 *  a message could be enqueued just as the agent decides to stop and is
 *  never drained. See openclaw's queueEmbeddedPiMessage for the same pattern. */
function buildSyncSteer(session: AgentSession): SyncSteer {
  return (content: string): boolean => {
    if (!session.agent.state.isStreaming) return false;
    try {
      // Bypass AgentSession.steer's async expansion path — for inbound channel
      // messages we don't want skill/template expansion. Go straight to the
      // underlying pi-agent steering queue.
      session.agent.steer({
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: Date.now(),
      });
      return true;
    } catch (err) {
      log.warn("Sync steer failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
}

async function* streamPiSession(
  session: AgentSession,
  content: string,
  abort: AbortSignal,
  images?: Array<{ type: "image"; data: string; mimeType: string }>,
): AsyncGenerator<AgentEvent> {
  const onAbort = () => session.abort();
  abort.addEventListener("abort", onAbort, { once: true });
  if (abort.aborted) session.abort();

  type QueueItem = AgentEvent | { type: "__error__"; error: unknown };
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  const unsub = session.subscribe((event) => {
    queue.push(event as AgentEvent);
    if (resolve) { resolve(); resolve = null; }
  });

  const promptOpts = images && images.length > 0 ? { images } : undefined;
  session.prompt(content, promptOpts).catch((err) => {
    queue.push({ type: "__error__", error: err });
    if (resolve) { resolve(); resolve = null; }
  });

  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => { resolve = r; });
      }
      const item = queue.shift()!;
      if ((item as { type: string }).type === "__error__") {
        throw (item as { error: unknown }).error;
      }
      const e = item as AgentEvent;
      yield e;
      if (e.type === "agent_end") return;
    }
  } finally {
    unsub();
    abort.removeEventListener("abort", onAbort);
  }
}
