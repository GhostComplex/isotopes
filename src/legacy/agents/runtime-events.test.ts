// Unit coverage for AgentRuntime's per-session event subscription facade
// (the SessionEventBus that replaces the standalone agentEventBus).
//
// These tests exercise the runtime's public on / emitSessionEvent /
// endSession / sessionListenerCount methods. They guard against
// regressions in:
//   - Multi-listener fan-out
//   - Per-listener unsubscribe
//   - Listener error isolation
//   - Cross-session isolation
//   - Lifecycle counts and endSession cleanup

import { describe, it, expect, vi } from "vitest";
import { AgentRuntime } from "./runtime.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

function makeEvent(text: string): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] } as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: { role: "assistant", content: [{ type: "text", text }] } as never,
    } as never,
  };
}

describe("AgentRuntime session event subscription", () => {
  it("delivers events to a subscribed listener", () => {
    const rt = new AgentRuntime();
    const seen: AgentEvent[] = [];
    rt.on("s", (e) => seen.push(e));

    rt.emitSessionEvent("s", makeEvent("a"));
    rt.emitSessionEvent("s", makeEvent("b"));

    expect(seen).toHaveLength(2);
  });

  it("fans out to multiple listeners on the same session", () => {
    const rt = new AgentRuntime();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    rt.on("s", (e) => a.push(e));
    rt.on("s", (e) => b.push(e));

    rt.emitSessionEvent("s", makeEvent("hi"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("returns an unsubscribe function that stops only that listener", () => {
    const rt = new AgentRuntime();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    const unsubA = rt.on("s", (e) => a.push(e));
    rt.on("s", (e) => b.push(e));

    rt.emitSessionEvent("s", makeEvent("1"));
    unsubA();
    rt.emitSessionEvent("s", makeEvent("2"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("isolates a throwing listener so others still receive the event", () => {
    const rt = new AgentRuntime();
    const seen: AgentEvent[] = [];
    rt.on("s", () => { throw new Error("boom"); });
    rt.on("s", (e) => seen.push(e));

    expect(() => rt.emitSessionEvent("s", makeEvent("x"))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("isolates events between sessions", () => {
    const rt = new AgentRuntime();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    rt.on("sessionA", (e) => a.push(e));
    rt.on("sessionB", (e) => b.push(e));

    rt.emitSessionEvent("sessionA", makeEvent("for-a"));
    rt.emitSessionEvent("sessionB", makeEvent("for-b"));
    rt.emitSessionEvent("sessionB", makeEvent("for-b-2"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("emit on a session with no listeners is a no-op", () => {
    const rt = new AgentRuntime();
    expect(() => rt.emitSessionEvent("nobody-home", makeEvent("x"))).not.toThrow();
  });

  it("sessionListenerCount tracks adds and unsubs", () => {
    const rt = new AgentRuntime();
    expect(rt.sessionListenerCount("s")).toBe(0);

    const u1 = rt.on("s", () => {});
    const u2 = rt.on("s", () => {});
    expect(rt.sessionListenerCount("s")).toBe(2);

    u1();
    expect(rt.sessionListenerCount("s")).toBe(1);

    u2();
    expect(rt.sessionListenerCount("s")).toBe(0);
  });

  it("endSession removes all listeners and stops further delivery", () => {
    const rt = new AgentRuntime();
    const seen: AgentEvent[] = [];
    rt.on("s", (e) => seen.push(e));
    rt.on("s", (e) => seen.push(e));

    expect(rt.sessionListenerCount("s")).toBe(2);

    rt.endSession("s");
    expect(rt.sessionListenerCount("s")).toBe(0);

    rt.emitSessionEvent("s", makeEvent("after-end"));
    expect(seen).toHaveLength(0);
  });

  it("endSession on an unknown session is a no-op", () => {
    const rt = new AgentRuntime();
    expect(() => rt.endSession("never-existed")).not.toThrow();
  });

  it("logs and swallows listener errors (no crash propagation)", () => {
    const rt = new AgentRuntime();
    const errSpy = vi.fn();
    rt.on("s", () => { throw new Error("nope"); });
    rt.on("s", errSpy);

    rt.emitSessionEvent("s", makeEvent("x"));

    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
