// Direct unit coverage for runAgent.

import { describe, it, expect, vi } from "vitest";
import { runAgent } from "./runtime-adapter.js";
import { AgentRuntime, type Runner } from "./runtime.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createLogger } from "../logging/logger.js";

const log = createLogger("test:agent-run");

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

function stubRunner(
  gen: (opts: { request: import("./types.js").RunRequest; abort: AbortSignal }) => AsyncGenerator<AgentEvent>,
): Runner {
  return {
    resolveSessionId: (req) => req.sessionId ?? "stub-session",
    async *run(opts) { yield* gen({ request: opts.request, abort: opts.abort }); },
  };
}

describe("runAgent", () => {
  it("accumulates text_delta into responseText", async () => {
    const rt = new AgentRuntime();
    rt.registerRunner("main", stubRunner(async function* () {
      yield buildTextDelta("Hello, ");
      yield buildTextDelta("world!");
      yield buildAgentEnd("Hello, world!");
    }));

    const result = await runAgent(rt, {
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
    rt.registerRunner("main", stubRunner(async function* () {
      yield buildAgentEnd("", "error", "boom");
    }));

    const result = await runAgent(rt, {
      to: "main",
      sessionId: "s2",
      content: "hi",
      log,
    });

    expect(result.errorMessage).toBe("boom");
  });

  it("does not scan listRuns to track the run", async () => {
    const rt = new AgentRuntime();
    rt.registerRunner("main", stubRunner(async function* () { yield buildAgentEnd("ok"); }));
    let scanCount = 0;
    const origList = rt.listRuns.bind(rt);
    rt.listRuns = (() => { scanCount++; return origList(); }) as typeof rt.listRuns;

    await runAgent(rt, {
      to: "main",
      sessionId: "s3",
      content: "hi",
      log,
    });

    // Adapter should not need listRuns lookup — sessionId is in scope.
    expect(scanCount).toBe(0);
  });

  it("emits every AgentEvent to runtime.on(sessionId)", async () => {
    const rt = new AgentRuntime();
    rt.registerRunner("main", stubRunner(async function* () {
      yield buildTextDelta("hi");
      yield buildAgentEnd("hi");
    }));

    const seen: AgentEvent["type"][] = [];
    const unsub = rt.on("s4", (e) => seen.push(e.type));
    try {
      await runAgent(rt, { to: "main", sessionId: "s4", content: "hi", log });
    } finally {
      unsub();
    }

    expect(seen).toEqual(["message_update", "agent_end"]);
  });

  it("calls onTurnEnd on turn_end and forwards drained text via runtime.steer", async () => {
    const rt = new AgentRuntime();
    rt.registerRunner("main", stubRunner(async function* () {
      yield {
        type: "turn_end",
        message: { role: "assistant" } as never,
        toolResults: [],
      } as AgentEvent;
      yield buildAgentEnd("done");
    }));
    const steerSpy = vi.spyOn(rt, "steer").mockResolvedValue();

    let calls = 0;
    await runAgent(rt, {
      to: "main",
      sessionId: "s5",
      content: "hi",
      log,
      onTurnEnd: async () => {
        calls++;
        return calls === 1 ? "[buffered]" : null;
      },
    });

    expect(calls).toBe(1);
    expect(steerSpy).toHaveBeenCalledWith(expect.any(String), "[buffered]");
  });
});

describe("runtime.cancel via sessionId", () => {
  it("cancels with explicit reason (default 'user')", async () => {
    const rt = new AgentRuntime();
    let pendingResolve: () => void = () => {};
    const pending = new Promise<void>((r) => { pendingResolve = r; });

    rt.registerRunner("main", stubRunner(async function* (opts) {
      pendingResolve();
      await new Promise<void>((r) => opts.abort.addEventListener("abort", () => r(), { once: true }));
      yield buildAgentEnd("done");
    }));

    let cancelReason: string | undefined;
    const drain = (async () => {
      for await (const _ of rt.run({
        to: "main",
        sessionId: "s6",
        content: "x",
        onCancel: (r) => { cancelReason = r; },
      })) { void _; }
    })();

    await pending;
    const ok = rt.cancel("s6", { reason: "user" });
    expect(ok).toBe(true);
    await drain;
    expect(cancelReason).toBe("user");
  });

  it("returns false when no run exists for the sessionId", () => {
    const rt = new AgentRuntime();
    expect(rt.cancel("nope")).toBe(false);
  });
});
