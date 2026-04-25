import { describe, it, expect, vi } from "vitest";
import { AgentEventBus, SessionEventEmitter } from "./agent-event-bus.js";
import type { AgentEvent } from "./types.js";

function fakeEvent(type: string): AgentEvent {
  return { type } as unknown as AgentEvent;
}

describe("SessionEventEmitter", () => {
  it("delivers events to listeners", () => {
    const emitter = new SessionEventEmitter();
    const fn = vi.fn();
    emitter.on(fn);
    const e = fakeEvent("agent_start");
    emitter.emit(e);
    expect(fn).toHaveBeenCalledWith(e);
  });

  it("supports multiple listeners", () => {
    const emitter = new SessionEventEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on(a);
    emitter.on(b);
    emitter.emit(fakeEvent("agent_end"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes via returned function", () => {
    const emitter = new SessionEventEmitter();
    const fn = vi.fn();
    const off = emitter.on(fn);
    off();
    emitter.emit(fakeEvent("agent_end"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not throw when emitting with no listeners", () => {
    const emitter = new SessionEventEmitter();
    expect(() => emitter.emit(fakeEvent("agent_end"))).not.toThrow();
  });

  it("isolates errors between listeners", () => {
    const emitter = new SessionEventEmitter();
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    emitter.on(bad);
    emitter.on(good);
    emitter.emit(fakeEvent("agent_end"));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("removeAll clears all listeners", () => {
    const emitter = new SessionEventEmitter();
    const fn = vi.fn();
    emitter.on(fn);
    emitter.removeAll();
    emitter.emit(fakeEvent("agent_end"));
    expect(fn).not.toHaveBeenCalled();
    expect(emitter.size).toBe(0);
  });
});

describe("AgentEventBus", () => {
  it("returns separate emitters per session", () => {
    const bus = new AgentEventBus();
    const e1 = bus.session("s1");
    const e2 = bus.session("s2");
    expect(e1).not.toBe(e2);
  });

  it("returns the same emitter for the same session", () => {
    const bus = new AgentEventBus();
    expect(bus.session("s1")).toBe(bus.session("s1"));
  });

  it("events on one session do not reach another session's listeners", () => {
    const bus = new AgentEventBus();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.session("s1").on(fn1);
    bus.session("s2").on(fn2);
    bus.session("s1").emit(fakeEvent("agent_start"));
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
  });

  it("removeSession clears emitter and listeners", () => {
    const bus = new AgentEventBus();
    const fn = vi.fn();
    bus.session("s1").on(fn);
    bus.removeSession("s1");
    // New emitter after removal
    bus.session("s1").emit(fakeEvent("agent_end"));
    expect(fn).not.toHaveBeenCalled();
  });
});
