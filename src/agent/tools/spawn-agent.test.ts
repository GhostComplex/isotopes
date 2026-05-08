import { describe, it, expect } from "vitest";
import { AgentRuntime, type Runner } from "../runtime.js";
import { createSpawnAgentTool } from "./spawn-agent.js";

function captureRunRequest() {
  let captured: { to: string; parentSessionId?: string; from?: { agentId: string } } | undefined;
  const runner: Runner = {
    resolveSessionId: () => "stub-session",
    async *run(opts) {
      captured = {
        to: opts.request.to,
        ...(opts.request.parentSessionId ? { parentSessionId: opts.request.parentSessionId } : {}),
        ...(opts.request.from ? { from: opts.request.from } : {}),
      };
      yield {
        type: "agent_end",
        messages: [],
        stopReason: "end",
      } as never;
    },
  };
  return { runner, get: () => captured };
}

describe("createSpawnAgentTool", () => {
  it("stamps the closure-bound parentSessionId on outgoing RunRequest", async () => {
    const rt = new AgentRuntime();
    const cap = captureRunRequest();
    rt.registerRunner("worker", cap.runner);

    const tool = createSpawnAgentTool({
      runtime: rt,
      parentAgentId: "main",
      parentSessionId: "session-from-closure",
      workspacePath: "/tmp",
    });

    await tool.execute("call-1", { to: "worker", content: "hi" }, new AbortController().signal);

    expect(cap.get()).toEqual({
      to: "worker",
      parentSessionId: "session-from-closure",
      from: { agentId: "main" },
    });
  });
});
