import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { RegisteredAgent, RunRequest } from "../types.js";
import { streamPiSession } from "./pi/runner.js";
import { createRootPiSession, type PiSessionDeps } from "./pi/session-factory.js";

export interface RegisteredAgentRunnerOptions {
  agent: RegisteredAgent;
  piDeps: PiSessionDeps;
}

/** Runner for registered isotopes agents (and built-in synthetic ones).
 * Falls back to in-memory session when agent.sessionStore is absent. */
export class RegisteredAgentRunner {
  constructor(private opts: RegisteredAgentRunnerOptions) {}

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
