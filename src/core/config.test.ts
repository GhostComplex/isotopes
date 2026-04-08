// src/core/config.test.ts — Unit tests for config loading

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  toAgentConfig,
  getDiscordToken,
  resolveToolSettings,
} from "./config.js";

describe("Config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-config-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("loadConfig", () => {
    it("loads YAML config", async () => {
      const configPath = path.join(tempDir, "isotopes.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: test
    name: Test Agent
    systemPrompt: You are helpful
`,
      );

      const config = await loadConfig(configPath);

      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].id).toBe("test");
      expect(config.agents[0].name).toBe("Test Agent");
    });

    it("loads JSON config", async () => {
      const configPath = path.join(tempDir, "isotopes.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: [{ id: "test", name: "Test" }],
        }),
      );

      const config = await loadConfig(configPath);

      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].id).toBe("test");
    });

    it("throws on missing agents array", async () => {
      const configPath = path.join(tempDir, "bad.yaml");
      await fs.writeFile(configPath, "provider:\n  type: openai");

      await expect(loadConfig(configPath)).rejects.toThrow(
        "Config must have an 'agents' array",
      );
    });

    it("substitutes environment variables", async () => {
      vi.stubEnv("TEST_API_KEY", "secret123");

      const configPath = path.join(tempDir, "env.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: test
    name: Test
provider:
  type: openai
  apiKey: \${TEST_API_KEY}
`,
      );

      const config = await loadConfig(configPath);

      expect(config.provider?.apiKey).toBe("secret123");
    });

    it("uses default value for missing env var", async () => {
      const configPath = path.join(tempDir, "default.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: test
    name: Test
provider:
  type: openai
  model: \${MODEL:-gpt-4}
`,
      );

      const config = await loadConfig(configPath);

      expect(config.provider?.model).toBe("gpt-4");
    });

    it("loads full config with all fields", async () => {
      const configPath = path.join(tempDir, "full.yaml");
      await fs.writeFile(
        configPath,
        `
provider:
  type: anthropic
  model: claude-3-opus

agents:
  - id: assistant
    name: Assistant
    systemPrompt: Be helpful
    workspacePath: ./workspaces/assistant
    provider:
      type: openai
      model: gpt-4o

discord:
  tokenEnv: DISCORD_TOKEN
  defaultAgentId: assistant
  agentBindings:
    "123456": assistant
  allowDMs: true
`,
      );

      const config = await loadConfig(configPath);

      expect(config.provider?.type).toBe("anthropic");
      expect(config.agents[0].provider?.type).toBe("openai");
      expect(config.discord?.defaultAgentId).toBe("assistant");
      expect(config.discord?.agentBindings?.["123456"]).toBe("assistant");
    });

    it("loads global and agent tool settings from the same config file", async () => {
      const configPath = path.join(tempDir, "tools.yaml");
      await fs.writeFile(
        configPath,
        `
tools:
  cli: false
  fs:
    workspaceOnly: true

agents:
  - id: assistant
    name: Assistant
    tools:
      cli: true
`,
      );

      const config = await loadConfig(configPath);

      expect(config.tools?.cli).toBe(false);
      expect(config.tools?.fs?.workspaceOnly).toBe(true);
      expect(config.agents[0].tools?.cli).toBe(true);
    });
  });

  describe("toAgentConfig", () => {
    it("converts config file agent to AgentConfig", () => {
      const agentFile = {
        id: "test",
        name: "Test Agent",
        systemPrompt: "Be helpful",
        workspacePath: "./workspace",
      };

      const config = toAgentConfig(agentFile);

      expect(config.id).toBe("test");
      expect(config.name).toBe("Test Agent");
      expect(config.systemPrompt).toBe("Be helpful");
      expect(config.workspacePath).toBe("./workspace");
    });

    it("uses default provider when agent has none", () => {
      const agentFile = { id: "test", name: "Test" };
      const defaultProvider = { type: "openai" as const, model: "gpt-4" };

      const config = toAgentConfig(agentFile, defaultProvider);

      expect(config.provider?.type).toBe("openai");
      expect(config.provider?.model).toBe("gpt-4");
    });

    it("prefers agent provider over default", () => {
      const agentFile = {
        id: "test",
        name: "Test",
        provider: { type: "anthropic" as const, model: "claude-3" },
      };
      const defaultProvider = { type: "openai" as const, model: "gpt-4" };

      const config = toAgentConfig(agentFile, defaultProvider);

      expect(config.provider?.type).toBe("anthropic");
    });

    it("merges tool settings with defaults", () => {
      const agentFile = {
        id: "test",
        name: "Test",
        tools: { cli: true },
      };
      const config = toAgentConfig(agentFile, undefined, {
        cli: false,
        fs: { workspaceOnly: true },
      });

      expect(config.toolSettings?.cli).toBe(true);
      expect(config.toolSettings?.fs?.workspaceOnly).toBe(true);
    });
  });

  describe("resolveToolSettings", () => {
    it("defaults cli off and workspaceOnly on", () => {
      expect(resolveToolSettings()).toEqual({
        cli: false,
        fs: { workspaceOnly: true },
      });
    });

    it("lets agent settings override global defaults", () => {
      expect(
        resolveToolSettings(
          { fs: { workspaceOnly: false } },
          { cli: true, fs: { workspaceOnly: true } },
        ),
      ).toEqual({
        cli: true,
        fs: { workspaceOnly: false },
      });
    });
  });

  describe("getDiscordToken", () => {
    it("returns direct token", () => {
      const token = getDiscordToken({ token: "my-token" });

      expect(token).toBe("my-token");
    });

    it("returns token from env var", () => {
      vi.stubEnv("MY_DISCORD_TOKEN", "env-token");

      const token = getDiscordToken({ tokenEnv: "MY_DISCORD_TOKEN" });

      expect(token).toBe("env-token");
    });

    it("throws when env var not set", () => {
      expect(() => getDiscordToken({ tokenEnv: "NONEXISTENT_VAR" })).toThrow(
        "Environment variable NONEXISTENT_VAR is not set",
      );
    });

    it("throws when neither token nor tokenEnv", () => {
      expect(() => getDiscordToken({})).toThrow(
        "Discord config must have either 'token' or 'tokenEnv'",
      );
    });
  });
});
