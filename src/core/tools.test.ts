// src/core/tools.test.ts — Unit tests for ToolRegistry

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ToolRegistry,
  createEchoTool,
  createTimeTool,
  type ToolHandler,
} from "./tools.js";
import type { Tool } from "./types.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    it("registers a tool", () => {
      const tool: Tool = {
        name: "test",
        description: "Test tool",
        parameters: {},
      };
      const handler: ToolHandler = async () => "result";

      registry.register(tool, handler);

      expect(registry.has("test")).toBe(true);
    });

    it("throws on duplicate registration", () => {
      const tool: Tool = {
        name: "test",
        description: "Test tool",
        parameters: {},
      };
      const handler: ToolHandler = async () => "result";

      registry.register(tool, handler);

      expect(() => registry.register(tool, handler)).toThrow(
        'Tool "test" already registered',
      );
    });
  });

  describe("get", () => {
    it("returns registered tool entry", () => {
      const tool: Tool = {
        name: "test",
        description: "Test tool",
        parameters: { foo: "bar" },
      };
      const handler: ToolHandler = async () => "result";

      registry.register(tool, handler);
      const entry = registry.get("test");

      expect(entry?.tool).toEqual(tool);
      expect(entry?.handler).toBe(handler);
    });

    it("returns undefined for unknown tool", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all tool schemas", () => {
      const tool1: Tool = { name: "a", description: "A", parameters: {} };
      const tool2: Tool = { name: "b", description: "B", parameters: {} };

      registry.register(tool1, async () => "");
      registry.register(tool2, async () => "");

      const tools = registry.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["a", "b"]);
    });

    it("returns empty array when no tools", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("execute", () => {
    it("executes tool handler with args", async () => {
      const handler = vi.fn().mockResolvedValue("executed");
      const tool: Tool = { name: "test", description: "", parameters: {} };

      registry.register(tool, handler);
      const result = await registry.execute("test", { key: "value" });

      expect(handler).toHaveBeenCalledWith({ key: "value" });
      expect(result).toBe("executed");
    });

    it("throws for unknown tool", async () => {
      await expect(registry.execute("unknown", {})).rejects.toThrow(
        'Tool "unknown" not found',
      );
    });

    it("propagates handler errors", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Handler failed"));
      const tool: Tool = { name: "test", description: "", parameters: {} };

      registry.register(tool, handler);

      await expect(registry.execute("test", {})).rejects.toThrow("Handler failed");
    });
  });

  describe("unregister", () => {
    it("removes registered tool", () => {
      const tool: Tool = { name: "test", description: "", parameters: {} };
      registry.register(tool, async () => "");

      expect(registry.unregister("test")).toBe(true);
      expect(registry.has("test")).toBe(false);
    });

    it("returns false for unknown tool", () => {
      expect(registry.unregister("unknown")).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes all tools", () => {
      registry.register({ name: "a", description: "", parameters: {} }, async () => "");
      registry.register({ name: "b", description: "", parameters: {} }, async () => "");

      registry.clear();

      expect(registry.list()).toHaveLength(0);
    });
  });
});

describe("Built-in tools", () => {
  describe("createEchoTool", () => {
    it("returns tool schema and handler", () => {
      const { tool, handler } = createEchoTool();

      expect(tool.name).toBe("echo");
      expect(tool.description.toLowerCase()).toContain("echo");
      expect(handler).toBeInstanceOf(Function);
    });

    it("echoes the message", async () => {
      const { handler } = createEchoTool();
      const result = await handler({ message: "Hello world" });

      expect(result).toBe("Hello world");
    });
  });

  describe("createTimeTool", () => {
    it("returns tool schema and handler", () => {
      const { tool, handler } = createTimeTool();

      expect(tool.name).toBe("get_current_time");
      expect(handler).toBeInstanceOf(Function);
    });

    it("returns ISO time by default", async () => {
      const { handler } = createTimeTool();
      const result = await handler({});

      // Should be ISO format
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("formats time with timezone", async () => {
      const { handler } = createTimeTool();
      const result = await handler({ timezone: "America/New_York" });

      // Should be formatted (not ISO)
      expect(result).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("handles invalid timezone gracefully", async () => {
      const { handler } = createTimeTool();
      const result = await handler({ timezone: "Invalid/Zone" });

      expect(result).toContain("Invalid timezone");
    });
  });
});
