import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { RunRequest } from "../types.js";
import { RunValidationError } from "../types.js";
import type { PiRunner } from "./pi/runner.js";
import { createLeafPiSession, type PiSessionDeps } from "./pi/session-factory.js";

export interface SubagentRunnerOptions {
  piRunner: PiRunner;
  piDeps: PiSessionDeps;
}

export class SubagentRunner {
  constructor(private opts: SubagentRunnerOptions) {}

  validateRequest(req: RunRequest): void {
    if (!req.leafContext) {
      throw new RunValidationError("subagent: leafContext is required");
    }
  }

  async *run(opts: {
    request: RunRequest;
    runId: string;
    abort: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const { request, runId, abort } = opts;
    const session = await createLeafPiSession(this.opts.piDeps, {
      leafContext: request.leafContext!,
      runId,
      content: request.content,
    });
    try {
      yield* this.opts.piRunner.run({ session, content: request.content, abort });
    } finally {
      session.dispose();
    }
  }
}
