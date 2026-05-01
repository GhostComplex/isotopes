import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { RegisteredAgent, RunRequest } from "../types.js";
import type { PiRunner } from "./pi/runner.js";
import { createRootPiSession, type PiSessionDeps } from "./pi/session-factory.js";

export interface RegisteredAgentRunnerOptions {
  agent: RegisteredAgent;
  piRunner: PiRunner;
  piDeps: PiSessionDeps;
}

/** Runner for registered isotopes agents. Uses store-backed session
 * (resumable across calls; parent-reuse / always-new policy). */
export class RegisteredAgentRunner {
  constructor(private opts: RegisteredAgentRunnerOptions) {}

  async resolveSessionId(req: RunRequest): Promise<string> {
    if (req.sessionId) return req.sessionId;
    const policy = this.opts.agent.sessionPolicy ?? "parent-reuse";
    const fromId = req.from?.agentId ?? "transport";
    const suffix = policy === "parent-reuse" && req.parentSessionId
      ? req.parentSessionId
      : randomUUID();
    const sessionKey = `peer:${fromId}:${suffix}`;
    const existing = await this.opts.agent.sessionStore.findByKey(sessionKey);
    if (existing) return existing.id;
    const created = await this.opts.agent.sessionStore.create(this.opts.agent.id, { key: sessionKey });
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
      yield* this.opts.piRunner.run({ session, content: request.content, abort });
    } finally {
      session.dispose();
    }
  }
}
