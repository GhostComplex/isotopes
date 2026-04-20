import { describe, it, expect } from "vitest";
import { renderConfig } from "./render.js";

describe("renderConfig", () => {
  it("emits a commented-out provider when llm is skipped", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip" });
    expect(yaml).toMatch(/^# provider:/m);
    expect(yaml).toContain("agents:");
    expect(yaml).toContain("- id: main");
    expect(yaml).not.toContain("channels:");
  });

  it("emits a ghc-proxy provider with literal apiKey", () => {
    const yaml = renderConfig({
      llm: "ghc-proxy",
      ghcProxy: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: "skip",
    });
    expect(yaml).toContain("type: anthropic-proxy");
    expect(yaml).toContain("baseUrl: https://api.example.com");
    expect(yaml).toContain("apiKey: sk-test");
    expect(yaml).toContain("model: claude-opus-4.7");
  });

  it("emits discord with dm disabled and group allowlist by default", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "discord",
      discord: { token: "bot-token-abc", dmPolicy: "disabled", groupPolicy: "allowlist" },
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
    });
    expect(yaml).toContain('- "111222333"');
    expect(yaml).toMatch(/dm:\s+policy: allowlist/);
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
    });
    expect(yaml).toMatch(/group:\s+policy: allowlist/);
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
    });
    expect(yaml).toMatch(/group:\s+policy: open/);
    expect(yaml).not.toContain("guildAllowlist:");
  });

  it("emits both provider and channel when both selected", () => {
    const yaml = renderConfig({
      llm: "ghc-proxy",
      ghcProxy: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: "discord",
      discord: { token: "bot-token-abc", dmPolicy: "disabled", groupPolicy: "allowlist" },
    });
    expect(yaml).toContain("type: anthropic-proxy");
    expect(yaml).toContain("token: bot-token-abc");
  });
});
