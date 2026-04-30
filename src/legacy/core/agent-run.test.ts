// Direct unit coverage for consumeRootRun + cancelRunBySessionId.

import { describe, it, expect, vi } from "vitest";
import { consumeRootRun, cancelRunBySessionId } from "./agent-run.js";
import { AgentRuntime } from "../agents/runtime.js";
import type { RegisteredAgent, SendMessageRequest } from "../agents/types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("test:agent-run");

function fakeAgent(id: string): RegisteredAgent {
  return {
    id,
    config: { id } as RegisteredAgent["config"],
    systemPrompt: "you are " + id,
    sessionStore: {
      findByKey: vi.fn(async () => undefined),
      create: vi.fn(async (_aid: string, opts?: { key?: string }) => ({
        id: opts?.key ?? "stub-session",
        agentId: _aid,
        lastActiveAt: new Date(),
      })),
    } as unknown as RegisteredAgent["sessionStore"],
    capabilities: { tools: [], canBeAddressed: true },
  };
}

function buildTextDelta(delta: string): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: delta }] } as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: { role: "assistant", content: [{ type: "text", text: delta }] } as never,
    } as never,
  };
}

function buildAgentEnd(text: string, stopReason = "end", errorMessage?: string): AgentEvent {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
      },
    ] as never,
  };
}

function installStub(rt: AgentRuntime, gen: (req: SendMessageRequest) => AsyncGenerator<AgentEvent>) {
  (rt as unknown as { piRunner: { sendMessage: typeof gen } }).piRunner = {
    sendMessage: gen as never,
  };
  (rt as unknown as { buildPiSession: () => Promise<unknown> }).buildPiSession =
    async () => ({ dispose: () => {}, abort: () => {} });
}

describe("consumeRootRun", () => {
  it("accumulates text_delta into responseText", async () => {
    const rt = new AgentRuntime();
    rt.registerAgent(fakeAgent("main"));
    installStub(rt, async function* () {
      yield buildTextDelta("Hello, ");
      yield buildTextDelta("world!");
      yield buildAgentEnd("Hello, world!");
    });

    const result = await consumeRootRun(rt, {
      to: "main",
      sessionId: "s1",
      content: "hi",
      log,
    });

    expect(result.responseText).toBe("Hello, world!");
    expect(result.errorMessage).toBeNull();
  });

  it("surfaces agent_end stopReason=error as errorMessage", async () => {
    const rt = new AgentRuntime();
    rt.registerAgent(fakeAgent("main"));
    installStub(rt, async function* () {
      yield buildAgentEnd("", "error", "boom");
    });

    const result = await consumeRootRun(rt, {
      to: "main",
      sessionId: "s2",
      content: "hi",
      log,
    });

    expect(result.errorMessage).toBe("boom");
  });

  it("captures runId via onRunStart (not by scanning listRuns)", async () => {
    const rt = new AgentRuntime();
    rt.registerAgent(fakeAgent("main"));
    let scanCount = 0;
    const origList = rt.listRuns.bind(rt);
    rt.listRuns = (() => { scanCount++; return origList(); }) as typeof rt.listRuns;

    installStub(rt, async function* () { yield buildAgentEnd("ok"); });

    await consumeRootRun(rt, {
      to: "main",
      sessionId: "s3",
      content: "hi",
      log,
    });

    // Should not be calling listRuns to find the runId — onRunStart wired it.
    expect(scanCount).toBe(0);
  });

  it("emits every AgentEvent to runtime.on(sessionId)", async () => {
    const rt = new AgentRuntime();
    rt.registerAgent(fakeAgent("main"));
    installStub(rt, async function* () {
      yield buildTextDelta("hi");
      yield buildAgentEnd("hi");
    });

    const seen: AgentEvent["type"][] = [];
    const unsub = rt.on("s4", (e) => seen.push(e.type));
    try {
      await consumeRootRun(rt, { to: "main", sessionId: "s4", content: "hi", log });
    } finally {
      unsub();
    }

    expect(seen).toEqual(["message_update", "agent_end"]);
  });

  it("calls onToolComplete on turn_end and forwards drained text via runtime.steer", async () => {
    const rt = new AgentRuntime();
    rt.registerAgent(fakeAgent("main"));
    const steerSpy = vi.spyOn(rt, "steer").mockResolvedValue();

    installStub(rt, async function* () {
      yield {
        type: "turn_end",
        message: { role: "assistant" } as never,
        toolResults: [],
      } as AgentEvent;
      yield buildAgentEnd("done");
    });

    let calls = 0;
    await consumeRootRun(rt, {
      to: "main",
      sessionId: "s5",
      content: "hi",
      log,
      onToolComplete: async () => {
        calls++;
        return calls === 1 ? "[buffered]" : null;
      },
    });

    expect(calls).toBe(1);
    expect(steerSpy).toHaveBeenCalledWith(expect.any(String), "[buffered]");
  });
});

describe("cancelRunBySessionId", () => {
  it("cancels with explicit reason (default 'user')", async () => {
    const rt = new AgentRuntime();
    rt.registerAgent(fakeAgent("main"));

    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });
    let cancelReason: string | undefined;

    installStub(rt, async function* (req) {
      req.onCancel = (reason) => { cancelReason = reason; };
      pendingResolve();
      await new Promise<void>((r) => req.cwd ? r() : setTimeout(r, 100));
      yield buildAgentEnd("done");
    });

    const drain = (async () => {
      for await (const _ of rt.sendMessage({
        to: "main",
        sessionId: "s6",
        content: "x",
        onCancel: (r) => { cancelReason = r; },
      })) { void _; }
    })();

    await pending;
    const ok = cancelRunBySessionId(rt, "s6", "user");
    expect(ok).toBe(true);
    await drain;
    expect(cancelReason).toBe("user");
  });

  it("returns false when no run exists for the sessionId", () => {
    const rt = new AgentRuntime();
    expect(cancelRunBySessionId(rt, "nope")).toBe(false);
  });
});
