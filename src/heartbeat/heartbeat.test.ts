// src/heartbeat/heartbeat.test.ts — Tests for HeartbeatManager

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatManager, DEFAULT_HEARTBEAT_PROMPT } from "./HeartbeatManager.js";

describe("HeartbeatManager", () => {
  let manager: HeartbeatManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new HeartbeatManager();
  });

  afterEach(() => {
    manager.stopAllHeartbeats();
    vi.useRealTimers();
  });

  // ---- Start / stop lifecycle ----

  it("starts a heartbeat and tracks it", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 1000, cb);

    expect(manager.hasHeartbeat("ch1")).toBe(true);
    expect(manager.size).toBe(1);
  });

  it("stops a heartbeat by channel", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 1000, cb);
    manager.stopHeartbeat("ch1");

    expect(manager.hasHeartbeat("ch1")).toBe(false);
    expect(manager.size).toBe(0);
  });

  it("stopHeartbeat is a no-op for unknown channels", () => {
    expect(() => manager.stopHeartbeat("unknown")).not.toThrow();
  });

  it("stopAllHeartbeats clears every channel", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "a1", 1000, cb);
    manager.startHeartbeat("ch2", "a2", 2000, cb);
    manager.startHeartbeat("ch3", "a3", 3000, cb);

    manager.stopAllHeartbeats();

    expect(manager.size).toBe(0);
    expect(manager.hasHeartbeat("ch1")).toBe(false);
  });

  it("replaces an existing heartbeat when started again", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    manager.startHeartbeat("ch1", "a1", 1000, cb1);
    manager.startHeartbeat("ch1", "a1", 1000, cb2);

    expect(manager.size).toBe(1);

    // Only cb2 should fire
    vi.advanceTimersByTime(1000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  // ---- Callback firing ----

  it("fires the callback at each interval", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 1000, cb);

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("ch1", "agent1");

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(5);
  });

  it("does not fire before the interval elapses", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 5000, cb);

    vi.advanceTimersByTime(4999);
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops firing after stopHeartbeat", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 1000, cb);

    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(2);

    manager.stopHeartbeat("ch1");

    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  // ---- Activity detection ----

  it("skips heartbeat when channel has recent activity", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 2000, cb);

    // Record activity at t=500 — within interval/2 (1000ms) of the first tick
    vi.advanceTimersByTime(500);
    manager.recordActivity("ch1");

    // Tick at t=2000 — last activity was 1500ms ago, threshold is 1000ms → fires
    vi.advanceTimersByTime(1500);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("skips heartbeat when activity is very recent", () => {
    const cb = vi.fn();
    manager.startHeartbeat("ch1", "agent1", 2000, cb);

    // Record activity at t=1500 — only 500ms before the tick at t=2000
    vi.advanceTimersByTime(1500);
    manager.recordActivity("ch1");

    // Tick at t=2000 — last activity was 500ms ago, threshold is 1000ms → skipped
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();

    // Next tick at t=4000 — last activity was 2500ms ago → fires
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("recordActivity is a no-op for channels without a heartbeat", () => {
    expect(() => manager.recordActivity("unknown")).not.toThrow();
  });

  // ---- Multiple channels ----

  it("manages independent heartbeats per channel", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.startHeartbeat("ch1", "a1", 1000, cb1);
    manager.startHeartbeat("ch2", "a2", 3000, cb2);

    vi.advanceTimersByTime(3000);

    // ch1 fires every 1s → 3 times; ch2 fires every 3s → 1 time
    expect(cb1).toHaveBeenCalledTimes(3);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("activity in one channel does not affect another", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.startHeartbeat("ch1", "a1", 2000, cb1);
    manager.startHeartbeat("ch2", "a2", 2000, cb2);

    // Activity on ch1 right before tick
    vi.advanceTimersByTime(1500);
    manager.recordActivity("ch1");

    vi.advanceTimersByTime(500);
    // ch1 skipped, ch2 fires
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  // ---- Error handling ----

  it("handles synchronous callback errors without crashing the timer", () => {
    const cb = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    manager.startHeartbeat("ch1", "agent1", 1000, cb);

    // Should not throw
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    // Timer still runs
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("handles async callback rejections without crashing the timer", () => {
    const cb = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("async boom"));
    manager.startHeartbeat("ch1", "agent1", 1000, cb);

    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(2);

    // Timer keeps going
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  // ---- Default prompt ----

  it("exports a default heartbeat prompt", () => {
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("[HEARTBEAT_OK]");
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("heartbeat");
  });
});
