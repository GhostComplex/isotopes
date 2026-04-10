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
  resolveCompactionConfigFromFile,
  resolveSessionConfig,
  resolveAcpConfig,
  resolveSandboxConfigFromFile,
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
      };

      const config = toAgentConfig(agentFile);

      expect(config.id).toBe("test");
      expect(config.name).toBe("Test Agent");
      expect(config.systemPrompt).toBe("");
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

    it("includes compaction config from agent-level", () => {
      const agentFile = {
        id: "test",
        name: "Test",
        compaction: { mode: "aggressive" },
      };
      const config = toAgentConfig(agentFile);

      expect(config.compaction?.mode).toBe("aggressive");
    });

    it("includes compaction config from defaults", () => {
      const agentFile = { id: "test", name: "Test" };
      const config = toAgentConfig(agentFile, undefined, undefined, {
        mode: "safeguard",
      });

      expect(config.compaction?.mode).toBe("safeguard");
    });

    it("agent compaction overrides default compaction", () => {
      const agentFile = {
        id: "test",
        name: "Test",
        compaction: { mode: "off" },
      };
      const config = toAgentConfig(agentFile, undefined, undefined, {
        mode: "safeguard",
      });

      expect(config.compaction?.mode).toBe("off");
    });

    it("omits compaction when neither agent nor default has it", () => {
      const agentFile = { id: "test", name: "Test" };
      const config = toAgentConfig(agentFile);

      expect(config.compaction).toBeUndefined();
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

  describe("resolveCompactionConfigFromFile", () => {
    it("returns undefined when neither agent nor default config provided", () => {
      expect(resolveCompactionConfigFromFile()).toBeUndefined();
    });

    it("returns config with defaults for safeguard mode", () => {
      const config = resolveCompactionConfigFromFile({ mode: "safeguard" });

      expect(config).toBeDefined();
      expect(config!.mode).toBe("safeguard");
    });

    it("agent config overrides default config", () => {
      const config = resolveCompactionConfigFromFile(
        { mode: "off" },
        { mode: "safeguard" },
      );

      expect(config!.mode).toBe("off");
    });

    it("merges agent and default config fields", () => {
      const config = resolveCompactionConfigFromFile(
        { contextWindow: 200_000 },
        { mode: "aggressive", threshold: 0.5 },
      );

      expect(config!.mode).toBe("aggressive");
      expect(config!.contextWindow).toBe(200_000);
      expect(config!.threshold).toBe(0.5);
    });

    it("throws on invalid mode", () => {
      expect(() =>
        resolveCompactionConfigFromFile({ mode: "invalid" }),
      ).toThrow('Invalid compaction mode "invalid"');
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

  describe("resolveSessionConfig", () => {
    it("returns undefined when no session config provided", () => {
      expect(resolveSessionConfig()).toBeUndefined();
    });

    it("returns config with ttl when provided", () => {
      const config = resolveSessionConfig({ ttl: 7200 });
      expect(config).toBeDefined();
      expect(config!.ttl).toBe(7200);
    });

    it("returns config with cleanupInterval when provided", () => {
      const config = resolveSessionConfig({ cleanupInterval: 1800 });
      expect(config).toBeDefined();
      expect(config!.cleanupInterval).toBe(1800);
    });

    it("returns config with both ttl and cleanupInterval", () => {
      const config = resolveSessionConfig({ ttl: 3600, cleanupInterval: 600 });
      expect(config).toBeDefined();
      expect(config!.ttl).toBe(3600);
      expect(config!.cleanupInterval).toBe(600);
    });

    it("throws on invalid ttl (zero)", () => {
      expect(() => resolveSessionConfig({ ttl: 0 })).toThrow(
        'Invalid session.ttl "0"',
      );
    });

    it("throws on invalid ttl (negative)", () => {
      expect(() => resolveSessionConfig({ ttl: -100 })).toThrow(
        'Invalid session.ttl "-100"',
      );
    });

    it("throws on invalid cleanupInterval (zero)", () => {
      expect(() => resolveSessionConfig({ cleanupInterval: 0 })).toThrow(
        'Invalid session.cleanupInterval "0"',
      );
    });

    it("throws on invalid cleanupInterval (negative)", () => {
      expect(() => resolveSessionConfig({ cleanupInterval: -60 })).toThrow(
        'Invalid session.cleanupInterval "-60"',
      );
    });

    it("returns empty object when session config has no fields", () => {
      const config = resolveSessionConfig({});
      expect(config).toBeDefined();
      expect(config!.ttl).toBeUndefined();
      expect(config!.cleanupInterval).toBeUndefined();
    });

    it("loads session config from YAML file", async () => {
      const configPath = path.join(tempDir, "session.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: test
    name: Test
session:
  ttl: 43200
  cleanupInterval: 1800
`,
      );

      const config = await loadConfig(configPath);
      expect(config.session?.ttl).toBe(43200);
      expect(config.session?.cleanupInterval).toBe(1800);
    });
  });

  describe("resolveAcpConfig", () => {
    it("returns undefined when config is undefined", () => {
      expect(resolveAcpConfig()).toBeUndefined();
    });

    it("returns undefined when enabled is false", () => {
      expect(resolveAcpConfig({ enabled: false, defaultAgent: "a" })).toBeUndefined();
    });

    it("returns config when enabled with valid fields", () => {
      const config = resolveAcpConfig({
        enabled: true,
        defaultAgent: "major",
        backend: "acpx",
      });

      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
      expect(config!.defaultAgent).toBe("major");
      expect(config!.backend).toBe("acpx");
    });

    it("defaults backend to 'acpx' when not specified", () => {
      const config = resolveAcpConfig({
        enabled: true,
        defaultAgent: "major",
      });

      expect(config!.backend).toBe("acpx");
    });

    it("passes through allowedAgents", () => {
      const config = resolveAcpConfig({
        enabled: true,
        defaultAgent: "major",
        allowedAgents: ["major", "sac"],
      });

      expect(config!.allowedAgents).toEqual(["major", "sac"]);
    });

    it("throws on invalid backend", () => {
      expect(() =>
        resolveAcpConfig({
          enabled: true,
          defaultAgent: "major",
          backend: "invalid" as "acpx",
        }),
      ).toThrow('Invalid acp.backend "invalid"');
    });

    it("throws when defaultAgent is missing", () => {
      expect(() =>
        resolveAcpConfig({ enabled: true }),
      ).toThrow("acp.defaultAgent is required when ACP is enabled");
    });
  });

  describe("resolveSandboxConfigFromFile", () => {
    it("returns undefined when neither agent nor default config provided", () => {
      expect(resolveSandboxConfigFromFile("test-agent")).toBeUndefined();
    });

    it("resolves agent-level sandbox config", () => {
      const config = resolveSandboxConfigFromFile("test-agent", {
        mode: "all",
        docker: { image: "custom:latest" },
      });

      expect(config).toBeDefined();
      expect(config!.mode).toBe("all");
      expect(config!.docker?.image).toBe("custom:latest");
    });

    it("resolves default sandbox config when agent has none", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        undefined,
        { mode: "non-main" },
      );

      expect(config).toBeDefined();
      expect(config!.mode).toBe("non-main");
    });

    it("agent config overrides default config", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        { mode: "off" },
        { mode: "all" },
      );

      expect(config!.mode).toBe("off");
    });
  });

  describe("loadConfig — edge cases", () => {
    it("throws when file does not exist", async () => {
      const configPath = path.join(tempDir, "nonexistent.yaml");

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it("loads file with unknown extension by trying YAML first", async () => {
      const configPath = path.join(tempDir, "config.toml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: test
    name: Test
`,
      );

      const config = await loadConfig(configPath);
      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].id).toBe("test");
    });

    it("falls back to JSON for unknown extension when YAML fails", async () => {
      const configPath = path.join(tempDir, "config.dat");
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: [{ id: "json-test", name: "JSON" }] }),
      );

      const config = await loadConfig(configPath);
      expect(config.agents[0].id).toBe("json-test");
    });
  });
});
