import { describe, it, expect, vi } from "vitest";
import { AgentEventBus } from "./agent-event-bus.js";
import type { AgentEvent } from "./types.js";

function fakeEvent(type: string): AgentEvent {
  return { type } as unknown as AgentEvent;
}

describe("AgentEventBus", () => {
  it("delivers events with sessionId to listeners", () => {
    const bus = new AgentEventBus();
    const fn = vi.fn();
    bus.on(fn);
    const e = fakeEvent("agent_start");
    bus.emit("sess-1", e);
    expect(fn).toHaveBeenCalledWith("sess-1", e);
  });

  it("supports multiple listeners", () => {
    const bus = new AgentEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on(a);
    bus.on(b);
    bus.emit("sess-1", fakeEvent("agent_end"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes via returned function", () => {
    const bus = new AgentEventBus();
    const fn = vi.fn();
    const off = bus.on(fn);
    off();
    bus.emit("sess-1", fakeEvent("agent_end"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not throw when emitting with no listeners", () => {
    const bus = new AgentEventBus();
    expect(() => bus.emit("sess-1", fakeEvent("agent_end"))).not.toThrow();
  });

  it("listeners can filter by sessionId", () => {
    const bus = new AgentEventBus();
    const events: AgentEvent[] = [];
    bus.on((sid, e) => {
      if (sid === "sess-2") events.push(e);
    });
    bus.emit("sess-1", fakeEvent("agent_start"));
    bus.emit("sess-2", fakeEvent("tool_execution_start"));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_execution_start");
  });
});
