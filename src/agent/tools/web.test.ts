import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetchTool } from "./web.js";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

function mockFetch(body: string, opts?: { status?: number; contentType?: string }): ReturnType<typeof vi.fn> {
  const status = opts?.status ?? 200;
  const contentType = opts?.contentType ?? "text/html";
  return vi.fn(async () =>
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    }),
  );
}

describe("createWebFetchTool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(""));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns tool with correct schema", () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe("web_fetch");
    expect(tool.parameters).toBeDefined();
  });

  it("rejects empty URL", async () => {
    const result = await callTool(createWebFetchTool(), { url: "" });
    expect(result).toContain("[error] URL cannot be empty");
  });

  it("rejects invalid URL", async () => {
    const result = await callTool(createWebFetchTool(), { url: "not-a-url" });
    expect(result).toContain("[error] Invalid URL");
  });

  it("converts HTML to markdown preserving structure", async () => {
    const html = `<html><body><h1>Title</h1><p>Paragraph with <a href="https://example.com">link</a>.</p><ul><li>item one</li><li>item two</li></ul></body></html>`;
    vi.stubGlobal("fetch", mockFetch(html, { contentType: "text/html" }));

    const result = await callTool(createWebFetchTool(), { url: "https://example.com" });
    expect(result).toContain("# Title");
    expect(result).toContain("[link](https://example.com)");
    expect(result).toMatch(/[*-]\s+item one/);
    expect(result).toMatch(/[*-]\s+item two/);
  });

  it("returns non-HTML content as-is", async () => {
    vi.stubGlobal("fetch", mockFetch('{"key":"value"}', { contentType: "application/json" }));
    const result = await callTool(createWebFetchTool(), { url: "https://api.example.com/data" });
    expect(result).toContain('{"key":"value"}');
  });

  it("upgrades http to https for non-localhost URLs", async () => {
    const fetchMock = mockFetch("<p>x</p>");
    vi.stubGlobal("fetch", fetchMock);

    await callTool(createWebFetchTool(), { url: "http://example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://example.com/");
  });

  it("does NOT upgrade http for localhost", async () => {
    const fetchMock = mockFetch("<p>x</p>");
    vi.stubGlobal("fetch", fetchMock);

    await callTool(createWebFetchTool(), { url: "http://localhost:8080/page" });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("http://localhost:8080/page");
  });

  it("sends honest User-Agent header", async () => {
    const fetchMock = mockFetch("<p>x</p>");
    vi.stubGlobal("fetch", fetchMock);

    await callTool(createWebFetchTool(), { url: "https://example.com" });
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["User-Agent"]).toBe("isotopes-web/0.1");
  });

  it("returns error for HTTP 4xx/5xx", async () => {
    vi.stubGlobal("fetch", mockFetch("", { status: 404 }));
    const result = await callTool(createWebFetchTool(), { url: "https://example.com/missing" });
    expect(result).toContain("[error] Failed to fetch");
    expect(result).toContain("404");
  });

  it("returns error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const result = await callTool(createWebFetchTool(), { url: "https://nonexistent.invalid" });
    expect(result).toContain("[error] Failed to fetch");
    expect(result).toContain("fetch failed");
  });

  it("truncates content over 50KB", async () => {
    const huge = "x".repeat(60000);
    vi.stubGlobal("fetch", mockFetch(`<pre>${huge}</pre>`));
    const result = await callTool(createWebFetchTool(), { url: "https://example.com" });
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(60000);
  });
});
