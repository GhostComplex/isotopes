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
`,
      );

      const config = await loadConfig(configPath);

      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].id).toBe("test");
    });

    it("loads JSON config", async () => {
      const configPath = path.join(tempDir, "isotopes.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: [{ id: "test" }],
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
    provider:
      type: openai
      model: gpt-4o

channels:
  discord:
    accounts:
      main:
        tokenEnv: DISCORD_TOKEN
        defaultAgentId: assistant
        agentBindings:
          "123456": assistant
        dm:
          policy: open
`,
      );

      const config = await loadConfig(configPath);

      expect(config.provider?.type).toBe("anthropic");
      expect(config.agents[0].provider?.type).toBe("openai");
      expect(config.channels?.discord?.accounts?.main?.defaultAgentId).toBe("assistant");
      expect(config.channels?.discord?.accounts?.main?.agentBindings?.["123456"]).toBe("assistant");
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
    tools:
      cli: true
`,
      );

      const config = await loadConfig(configPath);

      expect(config.tools?.cli).toBe(false);
      expect(config.tools?.fs?.workspaceOnly).toBe(true);
      expect(config.agents[0].tools?.cli).toBe(true);
    });

    it("loads object-form agents with defaults", async () => {
      const configPath = path.join(tempDir, "defaults.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  defaults:
    provider:
      type: anthropic-proxy
      baseUrl: https://proxy.example.com
      model: claude-sonnet
  list:
    - id: major
    - id: tachikoma
      provider:
        type: openai
        model: gpt-4o
`,
      );

      const config = await loadConfig(configPath);

      // agents should be normalized to array
      expect(Array.isArray(config.agents)).toBe(true);
      expect(config.agents.length).toBe(2);
      expect(config.agents[0].id).toBe("major");
      expect(config.agents[1].id).toBe("tachikoma");

      // agentDefaults should be extracted
      expect(config.agentDefaults).toBeDefined();
      expect(config.agentDefaults?.provider?.type).toBe("anthropic-proxy");
      expect(config.agentDefaults?.provider?.model).toBe("claude-sonnet");
    });

    it("legacy array form still works and agentDefaults is undefined", async () => {
      const configPath = path.join(tempDir, "legacy.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: test
`,
      );

      const config = await loadConfig(configPath);

      expect(Array.isArray(config.agents)).toBe(true);
      expect(config.agentDefaults).toBeUndefined();
    });

    it("throws when agents object form has no list", async () => {
      const configPath = path.join(tempDir, "bad-obj.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  defaults:
    provider:
      type: openai
`,
      );

      await expect(loadConfig(configPath)).rejects.toThrow();
    });
    it("loads agent workspace path from config", async () => {
      const configPath = path.join(tempDir, "workspace.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: major
    workspace: /custom/major-workspace
  - id: tachikoma
    workspace: ./tachikoma-ws
  - id: default-agent
`,
      );

      const config = await loadConfig(configPath);

      expect(config.agents[0].workspace).toBe("/custom/major-workspace");
      expect(config.agents[1].workspace).toBe("./tachikoma-ws");
      expect(config.agents[2].workspace).toBeUndefined();
    });
  });

  describe("toAgentConfig", () => {
    it("converts config file agent to AgentConfig", () => {
      const agentFile = {
        id: "test",
      };

      const config = toAgentConfig(agentFile);

      expect(config.id).toBe("test");
      expect(config.systemPrompt).toBe("");
    });

    it("uses default provider when agent has none", () => {
      const agentFile = { id: "test" };
      const defaultProvider = { type: "openai" as const, model: "gpt-4" };

      const config = toAgentConfig(agentFile, undefined, defaultProvider);

      expect(config.provider?.type).toBe("openai");
      expect(config.provider?.model).toBe("gpt-4");
    });

    it("prefers agent provider over default", () => {
      const agentFile = {
        id: "test",
        provider: { type: "anthropic" as const, model: "claude-3" },
      };
      const defaultProvider = { type: "openai" as const, model: "gpt-4" };

      const config = toAgentConfig(agentFile, undefined, defaultProvider);

      expect(config.provider?.type).toBe("anthropic");
    });

    it("merges tool settings with defaults", () => {
      const agentFile = {
        id: "test",
        tools: { cli: true },
      };
      const config = toAgentConfig(agentFile, undefined, undefined, {
        cli: false,
        fs: { workspaceOnly: true },
      });

      expect(config.toolSettings?.cli).toBe(true);
      expect(config.toolSettings?.fs?.workspaceOnly).toBe(true);
    });

    it("includes compaction config from agent-level", () => {
      const agentFile = {
        id: "test",
        compaction: { mode: "aggressive" },
      };
      const config = toAgentConfig(agentFile);

      expect(config.compaction?.mode).toBe("aggressive");
    });

    it("includes compaction config from defaults", () => {
      const agentFile = { id: "test" };
      const config = toAgentConfig(agentFile, undefined, undefined, undefined, {
        mode: "safeguard",
      });

      expect(config.compaction?.mode).toBe("safeguard");
    });

    it("agent compaction overrides default compaction", () => {
      const agentFile = {
        id: "test",
        compaction: { mode: "off" },
      };
      const config = toAgentConfig(agentFile, undefined, undefined, undefined, {
        mode: "safeguard",
      });

      expect(config.compaction?.mode).toBe("off");
    });

    it("omits compaction when neither agent nor default has it", () => {
      const agentFile = { id: "test" };
      const config = toAgentConfig(agentFile);

      expect(config.compaction).toBeUndefined();
    });

    it("inherits provider from agentDefaults", () => {
      const agentFile = { id: "test" };
      const defaults = { provider: { type: "anthropic-proxy" as const, model: "claude-sonnet" } };

      const config = toAgentConfig(agentFile, defaults);

      expect(config.provider?.type).toBe("anthropic-proxy");
      expect(config.provider?.model).toBe("claude-sonnet");
    });

    it("agent provider overrides agentDefaults provider", () => {
      const agentFile = {
        id: "test",
        provider: { type: "openai" as const, model: "gpt-4o" },
      };
      const defaults = { provider: { type: "anthropic-proxy" as const, model: "claude-sonnet" } };

      const config = toAgentConfig(agentFile, defaults);

      expect(config.provider?.type).toBe("openai");
      expect(config.provider?.model).toBe("gpt-4o");
    });

    it("agentDefaults provider overrides global provider", () => {
      const agentFile = { id: "test" };
      const defaults = { provider: { type: "anthropic-proxy" as const, model: "claude-sonnet" } };
      const globalProvider = { type: "openai" as const, model: "gpt-4" };

      const config = toAgentConfig(agentFile, defaults, globalProvider);

      expect(config.provider?.type).toBe("anthropic-proxy");
      expect(config.provider?.model).toBe("claude-sonnet");
    });

    it("falls through to global provider when no agent or defaults provider", () => {
      const agentFile = { id: "test" };
      const defaults = { compaction: { mode: "aggressive" } };
      const globalProvider = { type: "openai" as const, model: "gpt-4" };

      const config = toAgentConfig(agentFile, defaults, globalProvider);

      expect(config.provider?.type).toBe("openai");
    });

    it("shallow replace: agent provider wins entirely over defaults provider", () => {
      const agentFile = {
        id: "test",
        provider: { type: "openai" as const },  // no model
      };
      const defaults = {
        provider: {
          type: "anthropic-proxy" as const,
          baseUrl: "https://proxy.example.com",
          model: "claude-sonnet",
        },
      };

      const config = toAgentConfig(agentFile, defaults);

      // Agent's entire provider block wins — no field-level merge from defaults
      expect(config.provider?.type).toBe("openai");
      expect(config.provider?.model).toBeUndefined();
      expect((config.provider as { baseUrl?: string })?.baseUrl).toBeUndefined();
    });

    it("inherits compaction from agentDefaults", () => {
      const agentFile = { id: "test" };
      const defaults = { compaction: { mode: "aggressive" } };

      const config = toAgentConfig(agentFile, defaults);

      expect(config.compaction?.mode).toBe("aggressive");
    });

    it("inherits tools from agentDefaults", () => {
      const agentFile = { id: "test" };
      const defaults = { tools: { cli: true } };

      const config = toAgentConfig(agentFile, defaults);

      expect(config.toolSettings?.cli).toBe(true);
    });
  });

  describe("resolveToolSettings", () => {
    it("defaults cli off and workspaceOnly on", () => {
      expect(resolveToolSettings()).toEqual({
        cli: false,
        fs: { workspaceOnly: true },
        allow: undefined,
        deny: undefined,
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
        allow: undefined,
        deny: undefined,
      });
    });

    it("passes through allow list from agent config", () => {
      const result = resolveToolSettings({ allow: ["read_file", "list_dir"] });
      expect(result.allow).toEqual(["read_file", "list_dir"]);
    });

    it("passes through deny list from agent config", () => {
      const result = resolveToolSettings({ deny: ["shell", "write_file"] });
      expect(result.deny).toEqual(["shell", "write_file"]);
    });

    it("agent allow overrides default allow", () => {
      const result = resolveToolSettings(
        { allow: ["read_file"] },
        { allow: ["read_file", "shell"] },
      );
      expect(result.allow).toEqual(["read_file"]);
    });

    it("agent deny overrides default deny", () => {
      const result = resolveToolSettings(
        { deny: ["shell"] },
        { deny: ["shell", "write_file"] },
      );
      expect(result.deny).toEqual(["shell"]);
    });

    it("falls back to default allow when agent has none", () => {
      const result = resolveToolSettings(
        {},
        { allow: ["read_file"] },
      );
      expect(result.allow).toEqual(["read_file"]);
    });

    it("falls back to default deny when agent has none", () => {
      const result = resolveToolSettings(
        {},
        { deny: ["shell"] },
      );
      expect(result.deny).toEqual(["shell"]);
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
        "Discord account config must have either 'token' or 'tokenEnv'",
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

  describe("resolveSandboxConfigFromFile", () => {
    it("returns undefined when neither agent nor default config provided", () => {
      expect(resolveSandboxConfigFromFile("test-agent")).toBeUndefined();
    });

    it("resolves an agents-level sandbox config (no per-agent override)", () => {
      const config = resolveSandboxConfigFromFile("test-agent", undefined, {
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

    it("per-agent { mode: 'off' } turns off sandbox while inheriting docker from defaults", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        { mode: "off" },
        { mode: "all", docker: { image: "team:latest" } },
      );

      expect(config!.mode).toBe("off");
      // Docker config still resolved from defaults — even though sandbox is
      // off here, downstream code can still read the resolved shape uniformly.
      expect(config!.docker?.image).toBe("team:latest");
    });

    it("rejects per-agent sandbox.docker with a clear error", () => {
      expect(() =>
        resolveSandboxConfigFromFile(
          "test-agent",
          { mode: "all", docker: { image: "agent-specific:latest" } },
          { mode: "all", docker: { image: "team:latest" } },
        ),
      ).toThrow(/sandbox\.docker is not supported at the per-agent level/);
    });

    it("propagates pidsLimit / capDrop / capAdd / noNewPrivileges from file", () => {
      const config = resolveSandboxConfigFromFile("test-agent", undefined, {
        mode: "all",
        docker: {
          image: "x:latest",
          pidsLimit: 512,
          capDrop: ["ALL"],
          capAdd: ["NET_ADMIN"],
          noNewPrivileges: false,
        },
      });

      expect(config!.docker?.pidsLimit).toBe(512);
      expect(config!.docker?.capDrop).toEqual(["ALL"]);
      expect(config!.docker?.capAdd).toEqual(["NET_ADMIN"]);
      expect(config!.docker?.noNewPrivileges).toBe(false);
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
        JSON.stringify({ agents: [{ id: "json-test" }] }),
      );

      const config = await loadConfig(configPath);
      expect(config.agents[0].id).toBe("json-test");
    });
  });

  describe("loadConfig — multi-account Discord", () => {
    it("loads multi-account Discord config from channels.discord.accounts", async () => {
      const configPath = path.join(tempDir, "multi-discord.yaml");
      await fs.writeFile(
        configPath,
        `
agents:
  - id: major
  - id: tachikoma
channels:
  discord:
    accounts:
      major:
        token: tok-major
        defaultAgentId: major
        context:
          historyTurns: 10
      tachikoma:
        token: tok-tachi
        defaultAgentId: tachikoma
`,
      );

      const config = await loadConfig(configPath);

      const accounts = config.channels?.discord?.accounts ?? {};
      expect(Object.keys(accounts)).toEqual(["major", "tachikoma"]);
      expect(accounts.major.token).toBe("tok-major");
      expect(accounts.tachikoma.defaultAgentId).toBe("tachikoma");
      expect(accounts.major.context?.historyTurns).toBe(10);
    });
  });
});
