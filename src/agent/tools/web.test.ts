import { describe, it, expect, vi } from "vitest";
import { createWebFetchTool } from "./web.js";
import type { Executor } from "../executor.js";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

async function callTool(tool: AgentTool, args: unknown): Promise<string> {
  const result: AgentToolResult<unknown> = await tool.execute("test-call", args as never);
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

function mockExecutor(curlStdout: string, opts?: { exitCode?: number; stderr?: string }): Executor {
  return {
    execute: vi.fn(async () => ({
      exitCode: opts?.exitCode ?? 0,
      stdout: Buffer.from(curlStdout),
      stderr: Buffer.from(opts?.stderr ?? ""),
    })),
    buildExecArgv: vi.fn(async (a: string[]) => a),
  };
}

function curlResponse(status: number, contentType: string, body: string): string {
  return `HTTP/1.1 ${status} OK\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
}

describe("createWebFetchTool", () => {
  it("returns tool with correct schema", () => {
    const tool = createWebFetchTool(mockExecutor(""));
    expect(tool.name).toBe("web_fetch");
    expect(tool.parameters).toBeDefined();
  });

  it("rejects empty URL", async () => {
    const result = await callTool(createWebFetchTool(mockExecutor("")), { url: "" });
    expect(result).toContain("[error] URL cannot be empty");
  });

  it("rejects invalid URL", async () => {
    const result = await callTool(createWebFetchTool(mockExecutor("")), { url: "not-a-url" });
    expect(result).toContain("[error] Invalid URL");
  });

  it("converts HTML to markdown preserving structure", async () => {
    const html = `<html><body><h1>Title</h1><p>Paragraph with <a href="https://example.com">link</a>.</p><ul><li>item one</li><li>item two</li></ul></body></html>`;
    const tool = createWebFetchTool(mockExecutor(curlResponse(200, "text/html", html)));

    const result = await callTool(tool, { url: "https://example.com" });
    expect(result).toContain("# Title");
    expect(result).toContain("[link](https://example.com)");
    expect(result).toMatch(/[*-]\s+item one/);
    expect(result).toMatch(/[*-]\s+item two/);
  });

  it("returns non-HTML content as-is", async () => {
    const tool = createWebFetchTool(mockExecutor(curlResponse(200, "application/json", '{"key":"value"}')));
    const result = await callTool(tool, { url: "https://api.example.com/data" });
    expect(result).toContain('{"key":"value"}');
  });

  it("upgrades http to https for non-localhost URLs in the curl argv", async () => {
    const exec = vi.fn<(argv: string[], opts?: unknown) => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>>(async () => ({
      exitCode: 0,
      stdout: Buffer.from(curlResponse(200, "text/html", "<p>x</p>")),
      stderr: Buffer.alloc(0),
    }));
    const executor: Executor = { execute: exec, buildExecArgv: async (a) => a };

    await callTool(createWebFetchTool(executor), { url: "http://example.com" });
    const argv = exec.mock.calls[0][0] as string[];
    expect(argv[argv.length - 1]).toBe("https://example.com/");
  });

  it("does NOT upgrade http for localhost", async () => {
    const exec = vi.fn<(argv: string[], opts?: unknown) => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>>(async () => ({
      exitCode: 0,
      stdout: Buffer.from(curlResponse(200, "text/html", "<p>x</p>")),
      stderr: Buffer.alloc(0),
    }));
    const executor: Executor = { execute: exec, buildExecArgv: async (a) => a };

    await callTool(createWebFetchTool(executor), { url: "http://localhost:8080/page" });
    const argv = exec.mock.calls[0][0] as string[];
    expect(argv[argv.length - 1]).toBe("http://localhost:8080/page");
  });

  it("uses curl with honest User-Agent", async () => {
    const exec = vi.fn<(argv: string[], opts?: unknown) => Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>>(async () => ({
      exitCode: 0,
      stdout: Buffer.from(curlResponse(200, "text/html", "<p>x</p>")),
      stderr: Buffer.alloc(0),
    }));
    const executor: Executor = { execute: exec, buildExecArgv: async (a) => a };

    await callTool(createWebFetchTool(executor), { url: "https://example.com" });
    const argv = exec.mock.calls[0][0] as string[];
    expect(argv).toContain("curl");
    const uaIdx = argv.indexOf("-A");
    expect(uaIdx).toBeGreaterThan(-1);
    expect(argv[uaIdx + 1]).toBe("isotopes-web/0.1");
  });

  it("returns error for HTTP 4xx/5xx", async () => {
    const tool = createWebFetchTool(mockExecutor(curlResponse(404, "text/html", "")));
    const result = await callTool(tool, { url: "https://example.com/missing" });
    expect(result).toContain("[error] Failed to fetch");
    expect(result).toContain("404");
  });

  it("returns error when curl exits non-zero", async () => {
    const tool = createWebFetchTool(mockExecutor("", { exitCode: 6, stderr: "Could not resolve host" }));
    const result = await callTool(tool, { url: "https://nonexistent.invalid" });
    expect(result).toContain("[error] Failed to fetch");
    expect(result).toContain("Could not resolve host");
  });

  it("truncates content over 50KB", async () => {
    const huge = "x".repeat(60000);
    const tool = createWebFetchTool(mockExecutor(curlResponse(200, "text/html", `<pre>${huge}</pre>`)));
    const result = await callTool(tool, { url: "https://example.com" });
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(60000);
  });
});
