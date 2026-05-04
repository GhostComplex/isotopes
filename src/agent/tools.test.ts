import { describe, it, expect } from "vitest";
import {
  createTimeTool,
  createAgentTools,
  applyToolPolicy,
} from "./tools.js";
import { createWebFetchTool } from "../legacy/tools/web.js";
import { ProcessRegistry } from "../legacy/tools/exec.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return (block as { text: string }).text;
}

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

describe("createAgentTools", () => {
  const baseOpts = () => ({
    workspacePath: "/tmp/ws",
    agentId: "test",
    processRegistry: new ProcessRegistry(),
  });

  it("registers fs tools + time + exec by default", () => {
    const tools = createAgentTools(baseOpts());
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("ls");
    expect(names).toContain("get_current_time");
    expect(names).toContain("exec");
  });

  it("adds web tools when settings.web is true", () => {
    const tools = createAgentTools({ ...baseOpts(), settings: { web: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });
});

describe("applyToolPolicy", () => {
  const tools = [createTimeTool(), createWebFetchTool()];

  it("returns all tools when policy is undefined", () => {
    expect(applyToolPolicy(tools)).toHaveLength(2);
  });

  it("returns all tools when policy has neither allow nor deny", () => {
    expect(applyToolPolicy(tools, {})).toHaveLength(2);
  });

  it("filters by allow list", () => {
    const out = applyToolPolicy(tools, { allow: ["get_current_time"] });
    expect(out.map((t) => t.name)).toEqual(["get_current_time"]);
  });

  it("filters by deny list", () => {
    const out = applyToolPolicy(tools, { deny: ["get_current_time"] });
    expect(out.map((t) => t.name)).toEqual(["web_fetch"]);
  });

  it("deny takes precedence over allow", () => {
    const out = applyToolPolicy(tools, { allow: ["get_current_time"], deny: ["get_current_time"] });
    expect(out).toEqual([]);
  });
});
