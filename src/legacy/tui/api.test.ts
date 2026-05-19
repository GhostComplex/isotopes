import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchStatus, fetchSessions, isDaemonRunning, createSession, getHistory, abortMessage, deleteSession, dispatch } from "./api.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchStatus", () => {
  it("returns parsed status", async () => {
    const data = { version: "0.1.0", uptime: 123, cronJobs: 2 };
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

describe("createSession", () => {
  it("posts to sessions endpoint", async () => {
    const data = { key: "tui", agentId: "bot", resumed: false };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await createSession("bot", "tui");
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:2712/api/sessions/bot",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionKey: "tui" }),
      }),
    );
  });
});

describe("fetchSessions", () => {
  it("returns all sessions", async () => {
    const data = { items: [{ key: "bot:main", agentId: "bot", status: "active", lastActivityAt: "" }] };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await fetchSessions();
    expect(result).toEqual(data.items);
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:2712/api/sessions");
  });
});

describe("getHistory", () => {
  it("returns messages for session", async () => {
    const data = { items: [{ role: "user", content: "hi" }] };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await getHistory("bot", "s1");
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:2712/api/sessions/bot/s1/messages");
  });
});

describe("abortMessage", () => {
  it("posts abort", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await abortMessage("bot", "s1");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:2712/api/sessions/bot/s1/abort",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("deleteSession", () => {
  it("sends delete", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await deleteSession("bot", "s1");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:2712/api/sessions/bot/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("parseSSELine", () => {
  it.skip("parseSSELine was removed — SSE parsing is inlined in attachStream", () => {});
});

describe("dispatch", () => {
  it("POSTs the message and returns ack", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ sessionId: "s", state: "new_run" }) });
    const ack = await dispatch("bot", "s1", "hi");
    expect(ack).toEqual({ sessionId: "s", state: "new_run" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:2712/api/sessions/bot/s1/dispatch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      }),
    );
  });
});
