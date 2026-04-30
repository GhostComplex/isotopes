import { describe, it, expect } from "vitest";
import {
  createEchoTool,
  createTimeTool,
  createWorkspaceToolsWithGuards,
  applyToolPolicy,
  buildToolGuardPrompt,
} from "./tools.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return (block as { text: string }).text;
}

describe("createEchoTool", () => {
  const tool = createEchoTool();

  it("has correct schema metadata", () => {
    expect(tool.name).toBe("echo");
    expect(tool.description).toBeTruthy();
  });

  it("echoes the input message", async () => {
    const result = await tool.execute("call-1", { message: "hello world" });
    expect(getText(result)).toBe("hello world");
  });
});

describe("createTimeTool", () => {
  const tool = createTimeTool();

  it("has correct schema metadata", () => {
    expect(tool.name).toBe("get_current_time");
  });

  it("returns ISO time when no timezone provided", async () => {
    const result = await tool.execute("call-1", {});
    expect(getText(result)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respects an IANA timezone", async () => {
    const result = await tool.execute("call-1", { timezone: "Asia/Shanghai" });
    expect(getText(result)).toBeTruthy();
  });

  it("falls back to UTC when timezone is invalid", async () => {
    const result = await tool.execute("call-1", { timezone: "Not/Real" });
    const text = getText(result);
    expect(text).toContain("Invalid timezone");
    expect(text).toMatch(/Current UTC: \d{4}-\d{2}-\d{2}T/);
  });
});

describe("createWorkspaceToolsWithGuards", () => {
  it("registers fs tools + time by default", () => {
    const tools = createWorkspaceToolsWithGuards({ workspacePath: "/tmp/ws" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("ls");
    expect(names).toContain("get_current_time");
  });

  it("adds web tools when settings.web is true", () => {
    const tools = createWorkspaceToolsWithGuards({
      workspacePath: "/tmp/ws",
      settings: { web: true },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });

  it("excludes write/edit when codingMode is send-message", () => {
    const tools = createWorkspaceToolsWithGuards({
      workspacePath: "/tmp/ws",
      codingMode: "send-message",
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
  });
});

describe("buildToolGuardPrompt", () => {
  it("includes each tool name and description plus workspace path", () => {
    const tools = [createEchoTool(), createTimeTool()];
    const prompt = buildToolGuardPrompt(tools, "/tmp/ws");
    expect(prompt).toContain("echo");
    expect(prompt).toContain("get_current_time");
    expect(prompt).toContain("/tmp/ws");
  });
});

describe("applyToolPolicy", () => {
  const tools = [createEchoTool(), createTimeTool()];

  it("returns all tools when policy is undefined", () => {
    expect(applyToolPolicy(tools)).toHaveLength(2);
  });

  it("returns all tools when policy has neither allow nor deny", () => {
    expect(applyToolPolicy(tools, {})).toHaveLength(2);
  });

  it("filters by allow list", () => {
    const out = applyToolPolicy(tools, { allow: ["echo"] });
    expect(out.map((t) => t.name)).toEqual(["echo"]);
  });

  it("filters by deny list", () => {
    const out = applyToolPolicy(tools, { deny: ["echo"] });
    expect(out.map((t) => t.name)).toEqual(["get_current_time"]);
  });

  it("deny takes precedence over allow", () => {
    const out = applyToolPolicy(tools, { allow: ["echo"], deny: ["echo"] });
    expect(out).toEqual([]);
  });
});
