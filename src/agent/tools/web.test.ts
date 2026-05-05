import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetchTool } from "./web.js";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

function mockFetchHtml(html: string, contentType = "text/html"): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Map([["content-type", contentType]]) as unknown as Headers,
    text: async () => html,
  } as Response);
}

describe("createWebFetchTool", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

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
    mockFetchHtml(`
      <html><body>
        <h1>Title</h1>
        <p>Paragraph with <a href="https://example.com">link</a>.</p>
        <ul><li>item one</li><li>item two</li></ul>
      </body></html>
    `);

    const result = await callTool(createWebFetchTool(), { url: "https://example.com" });
    expect(result).toContain("# Title");
    expect(result).toContain("[link](https://example.com)");
    expect(result).toMatch(/[*-]\s+item one/);
    expect(result).toMatch(/[*-]\s+item two/);
  });

  it("returns non-HTML content as-is", async () => {
    mockFetchHtml('{"key":"value"}', "application/json");

    const result = await callTool(createWebFetchTool(), { url: "https://api.example.com/data" });
    expect(result).toContain('{"key":"value"}');
  });

  it("upgrades http to https for non-localhost URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
      text: async () => "<p>x</p>",
    } as Response);
    global.fetch = fetchMock;

    await callTool(createWebFetchTool(), { url: "http://example.com" });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://example.com/");
  });

  it("does NOT upgrade http for localhost", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
      text: async () => "<p>x</p>",
    } as Response);
    global.fetch = fetchMock;

    await callTool(createWebFetchTool(), { url: "http://localhost:8080/page" });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("http://localhost:8080/page");
  });

  it("returns error on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: "Not Found",
      headers: new Map() as unknown as Headers,
      text: async () => "",
    } as Response);

    const result = await callTool(createWebFetchTool(), { url: "https://example.com/missing" });
    expect(result).toContain("[error] Failed to fetch");
    expect(result).toContain("404");
  });

  it("uses honest User-Agent (not faked Chrome)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
      text: async () => "<p>x</p>",
    } as Response);
    global.fetch = fetchMock;

    await callTool(createWebFetchTool(), { url: "https://example.com" });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("isotopes-web/0.1");
  });

  it("truncates content over 50KB", async () => {
    const huge = "x".repeat(60000);
    mockFetchHtml(`<html><body><pre>${huge}</pre></body></html>`);

    const result = await callTool(createWebFetchTool(), { url: "https://example.com" });
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(60000);
  });
});
