import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchStatus, fetchSessions, fetchUsage, isDaemonRunning } from "./api.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchStatus", () => {
  it("returns parsed status", async () => {
    const data = { version: "0.0.2", uptime: 123, cronJobs: 2 };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await fetchStatus();
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:2712/api/status");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal" });
    await expect(fetchStatus()).rejects.toThrow("API /api/status: 500 Internal");
  });
});

describe("fetchSessions", () => {
  it("returns session list", async () => {
    const data = [{ id: "s1", agentId: "bot", source: "discord", status: "active", lastActivityAt: "" }];
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await fetchSessions();
    expect(result).toEqual(data);
  });
});

describe("fetchUsage", () => {
  it("returns usage stats", async () => {
    const data = { totalTokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 5 };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await fetchUsage();
    expect(result).toEqual(data);
  });
});

describe("isDaemonRunning", () => {
  it("returns true when daemon responds", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    expect(await isDaemonRunning()).toBe(true);
  });

  it("returns false when fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isDaemonRunning()).toBe(false);
  });
});
