// src/tools/web.ts — Web fetch and search tools

import type { Tool } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum content length to return (prevent context overflow) */
const MAX_CONTENT_LENGTH = 50000;

/** User agent for HTTP requests */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Request timeout in ms */
const REQUEST_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// Web Fetch Tool (HTTP GET + HTML to text)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and convert HTML to readable text.
 */
async function fetchAndConvert(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
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
  const html = await response.text();

  // If it's not HTML, return as-is (might be plain text, JSON, etc.)
  if (!contentType.includes("html")) {
    return truncateContent(html, MAX_CONTENT_LENGTH);
  }

  // Convert HTML to readable text
  const text = htmlToText(html);
  return truncateContent(text, MAX_CONTENT_LENGTH);
}

/**
 * Convert HTML to readable plain text.
 * Extracts main content and removes boilerplate.
 */
function htmlToText(html: string): string {
  // Remove script, style, nav, header, footer, aside
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Try to extract main content
  const mainMatch = text.match(/<main[\s\S]*?<\/main>/i)
    || text.match(/<article[\s\S]*?<\/article>/i)
    || text.match(/<div[^>]*(?:class|id)="[^"]*(?:content|main|article)[^"]*"[\s\S]*?<\/div>/i);

  if (mainMatch) {
    text = mainMatch[0];
  }

  // Extract title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "";

  // Convert HTML to plain text
  text = text
    // Headings to text with newlines
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n$1\n\n")
    // Paragraphs
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<\/p>/gi, "")
    // Line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Lists
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    // Links - keep text
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  // Clean up whitespace
  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

  // Prepend title if found
  if (title) {
    text = `# ${title}\n\n${text}`;
  }

  return text;
}

/**
 * Create web_fetch tool.
 */
export function createWebFetchTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "web_fetch",
      description:
        "Fetch and read the content of a web page. Converts HTML to readable text. Use to read documentation, articles, or any URL directly.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
        },
        required: ["url"],
      },
    },
    handler: async (args) => {
      const { url } = args as { url: string };

      if (!url || url.trim().length === 0) {
        return "[error] URL cannot be empty";
      }

      // Basic URL validation
      try {
        new URL(url);
      } catch {
        return `[error] Invalid URL: ${url}`;
      }

      try {
        const content = await fetchAndConvert(url);
        return `Content from ${url}:\n\n${content}`;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return `[error] Failed to fetch: ${err}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Web Search Tool (DuckDuckGo HTML scraping)
// ---------------------------------------------------------------------------

/** A single search result. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse DuckDuckGo HTML search results into structured data.
 */
export function parseDuckDuckGoResults(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result links: <a rel="nofollow" class="result__a" href="URL">Title</a>
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Match snippets: <a class="result__snippet" ...>Snippet</a> or <span class="result__snippet">...</span>
  const snippetRegex = /<(?:a|span)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/gi;

  const links: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    let url = match[1];
    // DuckDuckGo wraps URLs in a redirect — extract actual URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
    if (title && url) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    const snippet = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "").trim());
    snippets.push(snippet);
  }

  for (let i = 0; i < Math.min(links.length, count); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || "",
    });
  }

  return results;
}

/**
 * Create web_search tool using DuckDuckGo HTML scraping.
 */
export function createWebSearchTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          count: {
            type: "number",
            description: "Number of results (1-10, default 5)",
          },
          region: {
            type: "string",
            description: "Region code (e.g., 'us-en', 'uk-en')",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args) => {
      const { query, count: rawCount, region } = args as {
        query: string;
        count?: number;
        region?: string;
      };

      if (!query || query.trim().length === 0) {
        return "[error] Search query cannot be empty";
      }

      const count = Math.max(1, Math.min(10, rawCount ?? 5));

      const params = new URLSearchParams({ q: query });
      if (region) {
        params.set("kl", region);
      }

      const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
          redirect: "follow",
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const results = parseDuckDuckGoResults(html, count);

        if (results.length === 0) {
          return `No results found for "${query}"`;
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return `Search results for "${query}":\n\n${formatted}`;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return `[error] Search failed: ${err}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + "\n\n[Content truncated - original length: " + content.length + " chars]";
}
