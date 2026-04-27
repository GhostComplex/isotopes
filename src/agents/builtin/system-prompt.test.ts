import { describe, it, expect } from "vitest";
import { buildSpawnAgentSystemPrompt } from "./system-prompt.js";

describe("buildSpawnAgentSystemPrompt", () => {
  it("includes the task body", () => {
    const out = buildSpawnAgentSystemPrompt({ task: "Find all TODOs in src/" });
    expect(out).toContain("Find all TODOs in src/");
    expect(out).toContain("Task:");
  });

  it("frames leaf role with read-only capabilities", () => {
    const out = buildSpawnAgentSystemPrompt({ task: "x" });
    expect(out).toContain("read-only");
    expect(out).toContain("cannot spawn further agents");
  });

  it("appends extra system prompt when provided", () => {
    const out = buildSpawnAgentSystemPrompt({
      task: "x",
      extraSystemPrompt: "Workspace lives at /repo.",
    });
    expect(out).toContain("Workspace lives at /repo.");
  });

  it("omits extra section when extraSystemPrompt is empty/whitespace", () => {
    const out = buildSpawnAgentSystemPrompt({ task: "x", extraSystemPrompt: "  " });
    const dividers = out.split("---").length - 1;
    expect(dividers).toBe(1);
  });

  it("trims the task body", () => {
    const out = buildSpawnAgentSystemPrompt({ task: "  hello  " });
    expect(out).toContain("\nhello");
    expect(out).not.toContain("  hello  ");
  });
});
