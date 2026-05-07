import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
  it("delivers to matching subscriber", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe({ sessionId: "s1" }, handler);
    bus.emit("s1", "agent1", { type: "turn_end", message: {} as never, toolResults: [] });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("filters by sessionId", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe({ sessionId: "s1" }, h1);
    bus.subscribe({ sessionId: "s2" }, h2);
    bus.emit("s1", "agent1", { type: "turn_end", message: {} as never, toolResults: [] });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).not.toHaveBeenCalled();
  });

  it("filters by agentId", () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.subscribe({ agentId: "main" }, h);
    bus.emit("s1", "other", { type: "turn_end", message: {} as never, toolResults: [] });
    bus.emit("s1", "main", { type: "turn_end", message: {} as never, toolResults: [] });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delivers to subscriber with no filter (broadcast)", () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.subscribe({}, h);
    bus.emit("any", "any", { type: "agent_start" });
    bus.emit("other", "other", { type: "agent_end", messages: [] });
    expect(h).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const h = vi.fn();
    const unsub = bus.subscribe({}, h);
    bus.emit("s1", "a", { type: "agent_start" });
    unsub();
    bus.emit("s1", "a", { type: "agent_start" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("swallows handler exceptions, continues to other subscribers", () => {
    const bus = new EventBus();
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    bus.subscribe({}, bad);
    bus.subscribe({}, good);
    bus.emit("s", "a", { type: "agent_start" });
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});
