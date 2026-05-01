// AgentRuntime registry + sendMessage validation. Flow tests live in
// runtime-flow.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { AgentRuntime, RESERVED_AGENT_IDS, LEAF_CONCURRENCY_CAP } from "./runtime.js";
import type { RegisteredAgent } from "../../agent/runtime/types.js";

function fakeAgent(id: string): RegisteredAgent {
  return {
    id,
    config: { id } as RegisteredAgent["config"],
    sessionStore: {} as RegisteredAgent["sessionStore"],
    capabilities: { tools: [], canBeAddressed: true },
  };
}

describe("AgentRuntime — agent registry", () => {
  let rt: AgentRuntime;
  beforeEach(() => { rt = new AgentRuntime(); });

  it("registers and retrieves agents", () => {
    const a = fakeAgent("main");
    rt.registerAgent(a);
    expect(rt.getAgent("main")).toBe(a);
    expect(rt.listAgents()).toEqual([a]);
  });

  it("rejects duplicate registration", () => {
    rt.registerAgent(fakeAgent("main"));
    expect(() => rt.registerAgent(fakeAgent("main"))).toThrow(/already registered/);
  });

  it("rejects reserved magic ids", () => {
    for (const id of RESERVED_AGENT_IDS) {
      expect(() => rt.registerAgent(fakeAgent(id))).toThrow(/reserved magic id/);
    }
  });

  it("unregisters", () => {
    rt.registerAgent(fakeAgent("main"));
    expect(rt.unregisterAgent("main")).toBe(true);
    expect(rt.getAgent("main")).toBeUndefined();
    expect(rt.unregisterAgent("ghost")).toBe(false);
  });
});

describe("AgentRuntime.sendMessage — validation", () => {
  let rt: AgentRuntime;
  beforeEach(() => { rt = new AgentRuntime(); });

  async function consume(gen: AsyncGenerator<unknown>): Promise<void> {
    for await (const _ev of gen) { void _ev; }
  }

  it("rejects unknown agent id", async () => {
    await expect(consume(rt.sendMessage({ to: "ghost", content: "hi" }))).rejects.toThrow(/Unknown agent/);
  });

  it("rejects claude target when no claude runner is configured", async () => {
    await expect(consume(rt.sendMessage({ to: "claude", content: "hi", cwd: "/tmp" })))
      .rejects.toThrow(/claude runner not configured/);
  });

  it("rejects subagent target without leafContext", async () => {
    await expect(consume(rt.sendMessage({ to: "subagent", content: "hi" }))).rejects.toThrow(/leafContext is required/);
  });

  it("rejects sessionId on subagent target", async () => {
    await expect(consume(rt.sendMessage({
      to: "subagent",
      content: "hi",
      sessionId: "x",
      leafContext: {} as never,
    }))).rejects.toThrow(/leaf sessions are not resumable/);
  });

  it("rejects sendMessage when no pi runner configured", async () => {
    rt.registerAgent(fakeAgent("main"));
    await expect(consume(rt.sendMessage({ to: "main", content: "hi" }))).rejects.toThrow(/pi runner not configured/);
  });
});

describe("AgentRuntime — listRuns / getStatus", () => {
  it("returns empty before any run", () => {
    const rt = new AgentRuntime();
    expect(rt.listRuns()).toEqual([]);
    expect(rt.getStatus("any")).toBeUndefined();
  });
});

describe("AgentRuntime — leaf concurrency cap constant", () => {
  it("exports cap of 5", () => {
    expect(LEAF_CONCURRENCY_CAP).toBe(5);
  });
});
