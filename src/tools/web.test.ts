// src/tools/web.test.ts — Tests for web fetch tool

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetchTool } from "./web.js";

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
});
