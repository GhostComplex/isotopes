// src/tools/web.test.ts — Tests for web fetch and search tools

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetchTool, createWebSearchTool, parseDuckDuckGoResults } from "./web.js";

describe("web tools", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createWebFetchTool", () => {
    it("returns tool with correct schema", () => {
      const { tool } = createWebFetchTool();
      expect(tool.name).toBe("web_fetch");
      expect(tool.description).toContain("web page");
      expect(tool.parameters.required).toContain("url");
    });

    it("returns error for empty URL", async () => {
      const { handler } = createWebFetchTool();
      const result = await handler({ url: "" });
      expect(result).toContain("[error]");
      expect(result).toContain("empty");
    });

    it("returns error for invalid URL", async () => {
      const { handler } = createWebFetchTool();
      const result = await handler({ url: "not-a-url" });
      expect(result).toContain("[error]");
      expect(result).toContain("Invalid URL");
    });

    it("fetches and converts HTML to text", async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Test Page</title></head>
          <body>
            <script>console.log("removed");</script>
            <style>.removed {}</style>
            <main>
              <h1>Main Heading</h1>
              <p>This is a paragraph.</p>
              <a href="https://example.com">Link text</a>
            </main>
          </body>
        </html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com/page" });

      expect(result).toContain("Test Page");
      expect(result).toContain("Main Heading");
      expect(result).toContain("This is a paragraph");
      expect(result).toContain("Link text");
      expect(result).not.toContain("console.log");
      expect(result).not.toContain(".removed");
    });

    it("handles non-HTML content", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        text: () => Promise.resolve('{"key": "value"}'),
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://api.example.com/data" });

      expect(result).toContain('{"key": "value"}');
    });

    it("handles HTTP error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com/missing" });

      expect(result).toContain("[error]");
      expect(result).toContain("404");
    });

    it("handles network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com" });

      expect(result).toContain("[error]");
      expect(result).toContain("Connection refused");
    });

    it("truncates long content", async () => {
      const longContent = "x".repeat(100000);
      const mockHtml = `<html><body><p>${longContent}</p></body></html>`;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com" });

      expect(result).toContain("[Content truncated");
      expect(result.length).toBeLessThan(100000);
    });

    it("extracts content from article tags", async () => {
      const mockHtml = `
        <html>
          <body>
            <div>Noise before</div>
            <article>
              <h2>Article Title</h2>
              <p>Article content here.</p>
            </article>
            <div>Noise after</div>
          </body>
        </html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com" });

      expect(result).toContain("Article Title");
      expect(result).toContain("Article content");
    });

    it("handles list items", async () => {
      const mockHtml = `
        <html><body>
          <ul>
            <li>Item 1</li>
            <li>Item 2</li>
            <li>Item 3</li>
          </ul>
        </body></html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com" });

      expect(result).toContain("• Item 1");
      expect(result).toContain("• Item 2");
    });

    it("decodes HTML entities", async () => {
      const mockHtml = `
        <html><body>
          <p>Less than: &lt; Greater than: &gt; Amp: &amp;</p>
          <p>Quote: &quot; Apostrophe: &#39;</p>
        </body></html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebFetchTool();
      const result = await handler({ url: "https://example.com" });

      expect(result).toContain("Less than: <");
      expect(result).toContain("Greater than: >");
      expect(result).toContain("Amp: &");
    });
  });

  describe("parseDuckDuckGoResults", () => {
    it("parses results with uddg redirect URLs", () => {
      const html = `
        <div class="result">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=abc">Example Page 1</a>
          <a class="result__snippet">This is the first snippet.</a>
        </div>
        <div class="result">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2&amp;rut=def">Example Page 2</a>
          <a class="result__snippet">This is the second snippet.</a>
        </div>
      `;

      const results = parseDuckDuckGoResults(html, 5);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        title: "Example Page 1",
        url: "https://example.com/page1",
        snippet: "This is the first snippet.",
      });
      expect(results[1]).toEqual({
        title: "Example Page 2",
        url: "https://example.com/page2",
        snippet: "This is the second snippet.",
      });
    });

    it("parses results with direct URLs", () => {
      const html = `
        <a class="result__a" href="https://direct.example.com">Direct Link</a>
        <a class="result__snippet">Direct snippet.</a>
      `;

      const results = parseDuckDuckGoResults(html, 5);
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe("https://direct.example.com");
      expect(results[0].title).toBe("Direct Link");
    });

    it("strips HTML tags from titles", () => {
      const html = `
        <a class="result__a" href="https://example.com"><b>Bold</b> Title</a>
        <a class="result__snippet">Snippet text.</a>
      `;

      const results = parseDuckDuckGoResults(html, 5);
      expect(results[0].title).toBe("Bold Title");
    });

    it("respects count limit", () => {
      const html = `
        <a class="result__a" href="https://example.com/1">Result 1</a>
        <a class="result__snippet">Snippet 1</a>
        <a class="result__a" href="https://example.com/2">Result 2</a>
        <a class="result__snippet">Snippet 2</a>
        <a class="result__a" href="https://example.com/3">Result 3</a>
        <a class="result__snippet">Snippet 3</a>
      `;

      const results = parseDuckDuckGoResults(html, 2);
      expect(results).toHaveLength(2);
    });

    it("returns empty array when no results found", () => {
      const html = `<html><body><div class="no-results">No results</div></body></html>`;
      const results = parseDuckDuckGoResults(html, 5);
      expect(results).toEqual([]);
    });

    it("handles missing snippets gracefully", () => {
      const html = `
        <a class="result__a" href="https://example.com/1">Result 1</a>
        <a class="result__a" href="https://example.com/2">Result 2</a>
        <a class="result__snippet">Only one snippet</a>
      `;

      const results = parseDuckDuckGoResults(html, 5);
      expect(results).toHaveLength(2);
      expect(results[0].snippet).toBe("Only one snippet");
      expect(results[1].snippet).toBe("");
    });

    it("handles span-based snippets", () => {
      const html = `
        <a class="result__a" href="https://example.com">Title</a>
        <span class="result__snippet">Span-based snippet.</span>
      `;

      const results = parseDuckDuckGoResults(html, 5);
      expect(results[0].snippet).toBe("Span-based snippet.");
    });

    it("decodes HTML entities in results", () => {
      const html = `
        <a class="result__a" href="https://example.com">Tom &amp; Jerry&#39;s Page</a>
        <a class="result__snippet">A &lt;great&gt; snippet with &quot;quotes&quot;.</a>
      `;

      const results = parseDuckDuckGoResults(html, 5);
      expect(results[0].title).toBe("Tom & Jerry's Page");
      expect(results[0].snippet).toBe('A <great> snippet with "quotes".');
    });
  });

  describe("createWebSearchTool", () => {
    it("returns tool with correct schema", () => {
      const { tool } = createWebSearchTool();
      expect(tool.name).toBe("web_search");
      expect(tool.description).toContain("DuckDuckGo");
      expect(tool.parameters.required).toContain("query");
      expect(tool.parameters.properties).toHaveProperty("query");
      expect(tool.parameters.properties).toHaveProperty("count");
      expect(tool.parameters.properties).toHaveProperty("region");
    });

    it("returns error for empty query", async () => {
      const { handler } = createWebSearchTool();
      const result = await handler({ query: "" });
      expect(result).toContain("[error]");
      expect(result).toContain("empty");
    });

    it("fetches and parses search results", async () => {
      const mockHtml = `
        <html><body>
          <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult&amp;rut=abc">Example Result</a>
            <a class="result__snippet">This is a test snippet for the search.</a>
          </div>
          <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.example.com&amp;rut=def">Other Result</a>
            <a class="result__snippet">Another snippet here.</a>
          </div>
        </body></html>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebSearchTool();
      const result = await handler({ query: "test search" });

      expect(result).toContain("Search results");
      expect(result).toContain("Example Result");
      expect(result).toContain("https://example.com/result");
      expect(result).toContain("This is a test snippet");
      expect(result).toContain("Other Result");

      // Verify fetch was called with correct URL
      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("html.duckduckgo.com/html/");
      expect(fetchCall[0]).toContain("q=test+search");
    });

    it("passes region parameter as kl", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html></html>"),
      });

      const { handler } = createWebSearchTool();
      await handler({ query: "test", region: "us-en" });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("kl=us-en");
    });

    it("clamps count to valid range", async () => {
      const mockHtml = `
        <a class="result__a" href="https://example.com/1">R1</a>
        <a class="result__snippet">S1</a>
        <a class="result__a" href="https://example.com/2">R2</a>
        <a class="result__snippet">S2</a>
        <a class="result__a" href="https://example.com/3">R3</a>
        <a class="result__snippet">S3</a>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      });

      const { handler } = createWebSearchTool();
      const result = await handler({ query: "test", count: 2 });

      // Should only show 2 results
      expect(result).toContain("1. R1");
      expect(result).toContain("2. R2");
      expect(result).not.toContain("3. R3");
    });

    it("returns message when no results found", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("<html><body>No results</body></html>"),
      });

      const { handler } = createWebSearchTool();
      const result = await handler({ query: "xyznonexistent" });

      expect(result).toContain("No results found");
    });

    it("handles HTTP error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      const { handler } = createWebSearchTool();
      const result = await handler({ query: "test" });

      expect(result).toContain("[error]");
      expect(result).toContain("503");
    });

    it("handles network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

      const { handler } = createWebSearchTool();
      const result = await handler({ query: "test" });

      expect(result).toContain("[error]");
      expect(result).toContain("Network timeout");
    });
  });
});
