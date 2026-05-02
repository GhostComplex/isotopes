import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { RegisteredAgent, RunRequest } from "../../types.js";
import { RunValidationError } from "../../types.js";
import { createRootPiSession, type PiSessionDeps } from "./session-factory.js";

export interface PiRunnerOptions {
  agent: RegisteredAgent;
  piDeps: PiSessionDeps;
}

/** Runs a pi-coding-agent session for a registered agent (user-defined or
 * built-in synthetic). Falls back to in-memory session when
 * agent.sessionStore is absent. */
export class PiRunner {
  constructor(private opts: PiRunnerOptions) {}

  validateRequest(req: RunRequest): void {
    if (!this.opts.agent.sessionStore && req.sessionId) {
      throw new RunValidationError(
        `${this.opts.agent.id}: sessions are not resumable; omit sessionId`,
      );
    }
  }

  async resolveSessionId(req: RunRequest, runId: string): Promise<string> {
    if (req.sessionId) return req.sessionId;
    const store = this.opts.agent.sessionStore;
    if (!store) return `${this.opts.agent.id}:${runId}`;
    const policy = this.opts.agent.sessionPolicy ?? "parent-reuse";
    const fromId = req.from?.agentId ?? "transport";
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
    runId: string;
    sessionId: string;
    abort: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const { request, sessionId, abort } = opts;
    const session = await createRootPiSession(this.opts.piDeps, {
      agent: this.opts.agent,
      sessionId,
      ...(request.cwd ? { cwd: request.cwd } : {}),
    });
    try {
      yield* streamPiSession(session, request.content, abort);
    } finally {
      session.dispose();
    }
  }
}

/** Drive a pi-coding-agent session for one prompt and yield its events.
 * Caller owns session lifecycle (creation + dispose). */
async function* streamPiSession(
  session: AgentSession,
  content: string,
  abort: AbortSignal,
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

  session.prompt(content).catch((err) => {
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
