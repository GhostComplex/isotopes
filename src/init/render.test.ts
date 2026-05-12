import { describe, it, expect } from "vitest";
import { renderConfig } from "./render.js";

describe("renderConfig", () => {
  it("emits a commented-out provider when provider is skipped", () => {
    const yaml = renderConfig({ provider: { type: "skip" }, channel: { type: "skip" }, codingAgent: "skip" });
    expect(yaml).toMatch(/^# provider:/m);
    expect(yaml).toContain("agents:");
    expect(yaml).toContain("- id: main");
    expect(yaml).not.toContain("channels:");
  });

  it("emits a ghc-proxy provider with literal apiKey + defaultModel", () => {
    const yaml = renderConfig({
      provider: { type: "ghc-proxy", baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: { type: "skip" },
      codingAgent: "skip",
    });
    expect(yaml).toContain("type: github-copilot");
    expect(yaml).toContain("baseUrl: https://api.example.com");
    expect(yaml).toContain("apiKey: sk-test");
    expect(yaml).toContain("defaultModel: claude-opus-4.7");
    expect(yaml).not.toContain("anthropic-proxy");
  });

  it("emits a minimax-cn provider without baseUrl (pi-ai ships it built-in)", () => {
    const yaml = renderConfig({
      provider: { type: "minimax-cn", apiKey: "mm-test", model: "MiniMax-M2.7" },
      channel: { type: "skip" },
      codingAgent: "skip",
    });
    expect(yaml).toContain("type: minimax-cn");
    expect(yaml).toContain("apiKey: mm-test");
    expect(yaml).toContain("defaultModel: MiniMax-M2.7");
    expect(yaml).not.toContain("baseUrl:");
    expect(yaml).not.toContain("github-copilot");
  });

  it("emits discord with dm disabled and group allowlist by default", () => {
    const yaml = renderConfig({
      provider: { type: "skip" },
      channel: { type: "discord", token: "bot-token-abc", dmPolicy: "disabled", groupPolicy: "allowlist" },
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
      provider: { type: "skip" },
      channel: { type: "discord", token: "tok", dmPolicy: "allowlist", dmUserId: "111222333", groupPolicy: "open" },
      codingAgent: "skip",
    });
    expect(yaml).toContain('- "111222333"');
    expect(yaml).toMatch(/dmAccess:\s+policy: allowlist/);
  });

  it("emits group allowlist with whole-guild entries (guildAllowlist only)", () => {
    const yaml = renderConfig({
      provider: { type: "skip" },
      channel: {
        type: "discord",
        token: "tok",
        dmPolicy: "disabled",
        groupPolicy: "allowlist",
        groupAllowlist: ["111222333", "444555666"],
      },
      codingAgent: "skip",
    });
    expect(yaml).toMatch(/groupAccess:\s+policy: allowlist/);
    expect(yaml).toContain("guildAllowlist:");
    expect(yaml).toContain('- "111222333"');
    expect(yaml).toContain('- "444555666"');
    expect(yaml).not.toContain("channelAllowlist:");
    // Per-guild requireMention scaffold so the user can flip it later.
    expect(yaml).toContain("guilds:");
    expect(yaml).toMatch(/"111222333":\s+requireMention: true/);
    expect(yaml).toMatch(/"444555666":\s+requireMention: true/);
  });

  it("emits group allowlist with channel-only entries (channelAllowlist only, drops guild prefix)", () => {
    const yaml = renderConfig({
      provider: { type: "skip" },
      channel: {
        type: "discord",
        token: "tok",
        dmPolicy: "disabled",
        groupPolicy: "allowlist",
        groupAllowlist: ["111222333/777888999", "111222333/444555666"],
      },
      codingAgent: "skip",
    });
    expect(yaml).toMatch(/groupAccess:\s+policy: allowlist/);
    expect(yaml).toContain("channelAllowlist:");
    expect(yaml).toContain('- "777888999"');
    expect(yaml).toContain('- "444555666"');
    expect(yaml).not.toContain("guildAllowlist:");
    expect(yaml).not.toContain('- "111222333"');
  });

  it("emits group open without allowlist entries", () => {
    const yaml = renderConfig({
      provider: { type: "skip" },
      channel: { type: "discord", token: "tok", dmPolicy: "disabled", groupPolicy: "open" },
      codingAgent: "skip",
    });
    expect(yaml).toMatch(/groupAccess:\s+policy: open/);
    expect(yaml).not.toContain("guildAllowlist:");
  });

  it("emits both provider and channel when both selected", () => {
    const yaml = renderConfig({
      provider: { type: "ghc-proxy", baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: { type: "discord", token: "bot-token-abc", dmPolicy: "disabled", groupPolicy: "allowlist" },
      codingAgent: "skip",
    });
    expect(yaml).toContain("type: github-copilot");
    expect(yaml).toContain("token: bot-token-abc");
  });

  it("adds a coding agent (spawnable, claude runner) when claude is enabled", () => {
    const yaml = renderConfig({ provider: { type: "skip" }, channel: { type: "skip" }, codingAgent: "claude" });
    expect(yaml).toMatch(/- id: coding\n {4}runner: claude\n {4}spawnable: true/);
  });

  it("omits the coding agent when claude is skipped", () => {
    const yaml = renderConfig({ provider: { type: "skip" }, channel: { type: "skip" }, codingAgent: "skip" });
    expect(yaml).not.toContain("- id: coding");
    expect(yaml).not.toContain("runner: claude");
  });

  it("does not emit the redundant `tools: {}` block", () => {
    const yaml = renderConfig({ provider: { type: "skip" }, channel: { type: "skip" }, codingAgent: "skip" });
    expect(yaml).not.toMatch(/^tools:/m);
  });

  it("does not hard-code a `subagent` agent (user adds when needed)", () => {
    const yaml = renderConfig({ provider: { type: "skip" }, channel: { type: "skip" }, codingAgent: "skip" });
    expect(yaml).not.toContain("- id: subagent");
  });
});
