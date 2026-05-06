import { describe, it, expect } from "vitest";
import { renderConfig } from "./render.js";

describe("renderConfig", () => {
  it("emits a commented-out provider when llm is skipped", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", codingAgent: "skip" });
    expect(yaml).toMatch(/^# provider:/m);
    expect(yaml).toContain("agents:");
    expect(yaml).toContain("- id: main");
    expect(yaml).not.toContain("channels:");
  });

  it("emits a ghc-proxy provider with literal apiKey + defaultModel", () => {
    const yaml = renderConfig({
      llm: "ghc-proxy",
      ghcProxy: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: "skip",
      codingAgent: "skip",
    });
    expect(yaml).toContain("type: github-copilot");
    expect(yaml).toContain("baseUrl: https://api.example.com");
    expect(yaml).toContain("apiKey: sk-test");
    expect(yaml).toContain("defaultModel: claude-opus-4.7");
    expect(yaml).not.toContain("anthropic-proxy");
  });

  it("emits discord with dm disabled and group allowlist by default", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "discord",
      discord: { token: "bot-token-abc", dmPolicy: "disabled", groupPolicy: "allowlist" },
      codingAgent: "skip",
    });
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("token: bot-token-abc");
    expect(yaml).toContain("defaultAgentId: main");
    expect(yaml).toContain("policy: disabled");
    expect(yaml).toContain("policy: allowlist");
  });

  it("emits dm allowlist with user ID", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "discord",
      discord: { token: "tok", dmPolicy: "allowlist", dmUserId: "111222333", groupPolicy: "open" },
      codingAgent: "skip",
    });
    expect(yaml).toContain('- "111222333"');
    expect(yaml).toMatch(/dmAccess:\s+policy: allowlist/);
  });

  it("emits group allowlist with guild and channel IDs", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "discord",
      discord: {
        token: "tok",
        dmPolicy: "disabled",
        groupPolicy: "allowlist",
        groupAllowlist: ["111222333", "444555666/777888999"],
      },
      codingAgent: "skip",
    });
    expect(yaml).toMatch(/groupAccess:\s+policy: allowlist/);
    expect(yaml).toContain('- "111222333"');
    expect(yaml).toContain('- "444555666"');
    expect(yaml).toContain('- "777888999"');
    expect(yaml).toContain("guildAllowlist:");
    expect(yaml).toContain("channelAllowlist:");
  });

  it("emits group open without allowlist entries", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "discord",
      discord: { token: "tok", dmPolicy: "disabled", groupPolicy: "open" },
      codingAgent: "skip",
    });
    expect(yaml).toMatch(/groupAccess:\s+policy: open/);
    expect(yaml).not.toContain("guildAllowlist:");
  });

  it("emits both provider and channel when both selected", () => {
    const yaml = renderConfig({
      llm: "ghc-proxy",
      ghcProxy: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: "discord",
      discord: { token: "bot-token-abc", dmPolicy: "disabled", groupPolicy: "allowlist" },
      codingAgent: "skip",
    });
    expect(yaml).toContain("type: github-copilot");
    expect(yaml).toContain("token: bot-token-abc");
  });

  it("adds a coding agent when claude is enabled", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", codingAgent: "claude" });
    expect(yaml).toMatch(/- id: coding\n {4}runner: claude/);
  });

  it("omits the coding agent when claude is skipped", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", codingAgent: "skip" });
    expect(yaml).not.toContain("- id: coding");
    expect(yaml).not.toContain("runner: claude");
  });

  it("does not emit the redundant `tools: {}` block", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", codingAgent: "skip" });
    expect(yaml).not.toMatch(/^tools:/m);
  });

  it("does not hard-code a `subagent` agent (user adds when needed)", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", codingAgent: "skip" });
    expect(yaml).not.toContain("- id: subagent");
  });
});
