// src/subagent/builtin/system-prompt.test.ts — Tests for builtin subagent prompt builder

import { describe, it, expect } from "vitest";
import { buildBuiltinSubagentSystemPrompt } from "./system-prompt.js";

describe("buildBuiltinSubagentSystemPrompt", () => {
  it("includes the task body", () => {
    const out = buildBuiltinSubagentSystemPrompt({ task: "Find all TODOs in src/", role: "leaf" });
    expect(out).toContain("Find all TODOs in src/");
    expect(out).toContain("Task:");
  });

  it("frames leaf role with read-only capabilities", () => {
    const out = buildBuiltinSubagentSystemPrompt({ task: "x", role: "leaf" });
    expect(out).toContain("read-only");
    expect(out).toContain("cannot spawn further subagents");
  });

  it("frames orchestrator role with delegation language", () => {
    const out = buildBuiltinSubagentSystemPrompt({ task: "x", role: "orchestrator" });
    expect(out).toContain("delegate");
    expect(out).not.toContain("cannot spawn further subagents");
  });

  it("appends extra system prompt when provided", () => {
    const out = buildBuiltinSubagentSystemPrompt({
      task: "x",
      role: "leaf",
      extraSystemPrompt: "Workspace lives at /repo.",
    });
    expect(out).toContain("Workspace lives at /repo.");
  });

  it("omits extra section when extraSystemPrompt is empty/whitespace", () => {
    const out = buildBuiltinSubagentSystemPrompt({ task: "x", role: "leaf", extraSystemPrompt: "  " });
    const dividers = out.split("---").length - 1;
    expect(dividers).toBe(1);
  });

  it("trims the task body", () => {
    const out = buildBuiltinSubagentSystemPrompt({ task: "  hello  ", role: "leaf" });
    expect(out).toContain("\nhello");
    expect(out).not.toContain("  hello  ");
  });
});
