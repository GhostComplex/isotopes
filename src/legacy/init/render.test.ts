import { describe, it, expect } from "vitest";
import { renderConfig } from "./render.js";

describe("renderConfig", () => {
  it("emits a commented-out provider when llm is skipped", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", subagent: "skip" });
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
      subagent: "skip",
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
      subagent: "skip",
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
      subagent: "skip",
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
      subagent: "skip",
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
      subagent: "skip",
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
      subagent: "skip",
    });
    expect(yaml).toContain("type: anthropic-proxy");
    expect(yaml).toContain("token: bot-token-abc");
  });

  it("emits commented-out subagent when skipped", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip", subagent: "skip" });
    expect(yaml).toMatch(/^# subagent:/m);
    expect(yaml).toMatch(/^#\s+enabled: true/m);
  });

  it("emits subagent with claude allowlist and no shell", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "skip",
      subagent: "enabled",
      subagentConfig: { allowedTypes: ["claude", "builtin"], permissionMode: "allowlist", enableShell: false },
    });
    expect(yaml).toMatch(/^subagent:/m);
    expect(yaml).toContain("enabled: true");
    expect(yaml).toContain("allowedTypes: [claude, builtin]");
    expect(yaml).toContain("permissionMode: allowlist");
    expect(yaml).toContain("enableShell: false");
  });

  it("emits subagent with skip permissions and shell enabled", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "skip",
      subagent: "enabled",
      subagentConfig: { allowedTypes: ["claude"], permissionMode: "skip", enableShell: true },
    });
    expect(yaml).toContain("allowedTypes: [claude]");
    expect(yaml).toContain("permissionMode: skip  # --dangerously-skip-permissions");
    expect(yaml).toContain("enableShell: true");
  });

  it("emits subagent builtin-only without claude block", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "skip",
      subagent: "enabled",
      subagentConfig: { allowedTypes: ["builtin"], permissionMode: "allowlist", enableShell: false },
    });
    expect(yaml).toContain("allowedTypes: [builtin]");
    expect(yaml).not.toContain("permissionMode:");
    expect(yaml).not.toContain("claude:");
  });
});
