import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { NodeHtmlMarkdown } from "node-html-markdown";

const MAX_CONTENT_LENGTH = 50000;
const REQUEST_TIMEOUT = 30000;
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

async function fetchAndConvert(url: string): Promise<string> {
  const response = await fetch(upgradeToHttps(url), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!contentType.includes("html")) {
    return body.length > MAX_CONTENT_LENGTH ? body.slice(0, MAX_CONTENT_LENGTH) + "\n\n[truncated]" : body;
  }

  const md = NodeHtmlMarkdown.translate(body);
  return md.length > MAX_CONTENT_LENGTH ? md.slice(0, MAX_CONTENT_LENGTH) + "\n\n[truncated]" : md;
}

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch" }),
});

export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
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
        const content = await fetchAndConvert(url);
        return textResult(`Content from ${url}:\n\n${content}`);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return textResult(`[error] Failed to fetch: ${err}`);
      }
    },
  };
}
