import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { Executor } from "../executor.js";

const MAX_CONTENT_LENGTH = 50000;
const REQUEST_TIMEOUT_SEC = 30;
const USER_AGENT = "isotopes-web/0.1";

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Upgrade non-localhost http URLs to https to reduce passive interception risk. */
function upgradeToHttps(rawUrl: string): string {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:") return u.toString();
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") return u.toString();
  u.protocol = "https:";
  return u.toString();
}

/**
 * Split `curl -i` output into the *final* response headers + body.
 * After redirects, curl emits one header block per hop separated by a
 * blank line; the last block belongs to the final response.
 */
function parseCurlIResponse(raw: string): { headers: string; body: string } {
  // Each header block ends with an empty line: \r\n\r\n or \n\n.
  // Split on the first blank line to peel one block at a time, keep the last.
  const normalized = raw.replace(/\r\n/g, "\n");
  const parts: string[] = [];
  let rest = normalized;
  while (true) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const head = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    // Header blocks start with HTTP/<version>; if the chunk doesn't, we've
    // entered the body — push remainder back as body.
    if (!/^HTTP\/[0-9.]+\s/i.test(head)) {
      // Reattach the chunk that didn't look like headers
      rest = head + "\n\n" + rest;
      break;
    }
    parts.push(head);
  }
  const headers = parts[parts.length - 1] ?? "";
  return { headers, body: rest };
}

async function fetchAndConvert(executor: Executor, url: string): Promise<string> {
  const finalUrl = upgradeToHttps(url);
  const argv = [
    "curl",
    "-sS",
    "-L",
    "-i",
    "--max-time", String(REQUEST_TIMEOUT_SEC),
    "-A", USER_AGENT,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    finalUrl,
  ];

  const result = await executor.execute(argv, { timeout: (REQUEST_TIMEOUT_SEC + 5) * 1000 });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(`curl exit ${result.exitCode}: ${stderr || "no stderr"}`);
  }

  const raw = result.stdout.toString("utf8");
  const { headers, body } = parseCurlIResponse(raw);

  const statusMatch = headers.match(/^HTTP\/[0-9.]+\s+(\d+)\s*([^\n]*)/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  if (!status || status >= 400) {
    throw new Error(`HTTP ${status || "?"}${statusMatch?.[2] ? `: ${statusMatch[2].trim()}` : ""}`);
  }

  const isHtml = /content-type:\s*[^\n]*html/i.test(headers);
  const content = isHtml ? NodeHtmlMarkdown.translate(body) : body;
  return content.length > MAX_CONTENT_LENGTH
    ? content.slice(0, MAX_CONTENT_LENGTH) + "\n\n[truncated]"
    : content;
}

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch" }),
});

export interface WebFetchToolOptions {
  executor: Executor;
}

export function createWebFetchTool(options: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
  const { executor } = options;
  return {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch a URL and return its content as markdown. HTML pages are converted to markdown preserving headings, links, lists, and code blocks. Non-HTML responses (JSON, plain text) are returned as-is. Truncated at 50KB.",
    parameters: webFetchSchema,
    execute: async (_id, { url }) => {
      if (!url || url.trim().length === 0) return textResult("[error] URL cannot be empty");
      try { new URL(url); } catch { return textResult(`[error] Invalid URL: ${url}`); }
      try {
        const content = await fetchAndConvert(executor, url);
        return textResult(`Content from ${url}:\n\n${content}`);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return textResult(`[error] Failed to fetch: ${err}`);
      }
    },
  };
}
