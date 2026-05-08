import { describe, it, expect } from "vitest";
import { createTimeTool } from "./time.js";
import { createAgentTools } from "./index.js";
import { AgentRuntime } from "../runtime.js";

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
    parentAgentId: "test",
    parentSessionId: "session-1",
    runtime: new AgentRuntime(),
  });

  it("registers fs tools + time + exec + spawn_agent by default", () => {
    const tools = createAgentTools(baseOpts());
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("ls");
    expect(names).toContain("get_current_time");
    expect(names).toContain("exec");
    expect(names).toContain("spawn_agent");
  });

  it("registers web_fetch by default", () => {
    const tools = createAgentTools(baseOpts());
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("web_search");
  });
});
