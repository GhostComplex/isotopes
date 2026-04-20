import { describe, it, expect } from "vitest";
import { renderConfig } from "./render.js";

describe("renderConfig", () => {
  it("emits a commented-out provider when llm is skipped", () => {
    const yaml = renderConfig({ llm: "skip", channel: "skip" });
    expect(yaml).toMatch(/^# provider:/m);
    expect(yaml).toContain("agents:");
    expect(yaml).toContain("- id: assistant");
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

  it("emits a discord channel block when discord token is provided", () => {
    const yaml = renderConfig({
      llm: "skip",
      channel: "discord",
      discord: { token: "bot-token-abc" },
    });
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("token: bot-token-abc");
    expect(yaml).toContain("defaultAgentId: assistant");
  });

  it("emits both provider and channel when both selected", () => {
    const yaml = renderConfig({
      llm: "ghc-proxy",
      ghcProxy: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-opus-4.7" },
      channel: "discord",
      discord: { token: "bot-token-abc" },
    });
    expect(yaml).toContain("type: anthropic-proxy");
    expect(yaml).toContain("token: bot-token-abc");
  });
});
