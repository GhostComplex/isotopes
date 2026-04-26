import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchStatus, fetchSessions, fetchUsage, isDaemonRunning, createSession, getHistory, abortMessage, deleteSession, parseSSELine } from "./api.js";

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

describe("createSession", () => {
  it("posts to chat sessions endpoint", async () => {
    const data = { sessionId: "s1", agentId: "bot", resumed: false };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });
    const result = await createSession("bot", "tui:main");
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:2712/api/sessions/bot",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionKey: "tui:main" }),
      }),
    );
  });
});

describe("fetchSessions", () => {
  it("returns all sessions", async () => {
    const data = { items: [{ id: "s1", agentId: "bot", status: "active", lastActivityAt: "" }] };
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
  it("parses text_delta", () => {
    const event = parseSSELine("text_delta", '{"text":"hello"}');
    expect(event).toEqual({ type: "text_delta", text: "hello" });
  });

  it("parses tool_call", () => {
    const event = parseSSELine("tool_call", '{"toolCallId":"t1","toolName":"echo","args":"hi"}');
    expect(event).toEqual({ type: "tool_call", toolCallId: "t1", toolName: "echo", args: "hi" });
  });

  it("parses tool_result", () => {
    const event = parseSSELine("tool_result", '{"toolCallId":"t1","toolName":"echo","result":"hi","isError":false}');
    expect(event).toEqual({ type: "tool_result", toolCallId: "t1", toolName: "echo", result: "hi", isError: false });
  });

  it("parses error", () => {
    const event = parseSSELine("error", '{"message":"boom"}');
    expect(event).toEqual({ type: "error", message: "boom" });
  });

  it("parses agent_end", () => {
    const event = parseSSELine("agent_end", '{"stopReason":"end"}');
    expect(event).toEqual({ type: "agent_end", stopReason: "end" });
  });

  it("returns null for empty event type", () => {
    expect(parseSSELine("", '{"text":"x"}')).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSSELine("text_delta", "not json")).toBeNull();
  });

  it("returns null for unknown event type", () => {
    expect(parseSSELine("unknown", '{"foo":"bar"}')).toBeNull();
  });
});
