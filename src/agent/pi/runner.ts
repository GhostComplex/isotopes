import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { RegisteredAgent, RunRequest } from "../types.js";
import { createPiSession, type PiSessionDeps } from "./session-factory.js";

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
  }): AsyncGenerator<AgentEvent> {
    const { request, sessionId, abort, onSession } = opts;
    const session = await createPiSession(this.opts.piDeps, {
      agent: this.opts.agent,
      sessionId,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.extraSystemPrompt ? { extraSystemPrompt: request.extraSystemPrompt } : {}),
    });
    onSession?.(session);
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
