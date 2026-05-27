// src/config.test.ts — Unit tests for config loading

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  toAgentConfig,
  resolveToolSettings,
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
  defaultModel: \${MODEL:-gpt-4}
`,
      );

      const config = await loadConfig(configPath);

      expect(config.provider?.defaultModel).toBe("gpt-4");
    });

    it("loads full config with all fields", async () => {
      const configPath = path.join(tempDir, "full.yaml");
      await fs.writeFile(
        configPath,
        `
provider:
  type: anthropic
  defaultModel: claude-3-opus

agents:
  - id: assistant
    model: gpt-4o

channels:
  discord:
    accounts:
      main:
        tokenEnv: DISCORD_TOKEN
        defaultAgentId: assistant
        perChannelAgent:
          "123456": assistant
        dmAccess:
          policy: open
`,
      );

      const config = await loadConfig(configPath);

      expect(config.provider?.type).toBe("anthropic");
      expect(config.agents[0].model).toBe("gpt-4o");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const discord = config.channels?.discord as any;
      expect(discord?.accounts?.main?.defaultAgentId).toBe("assistant");
      expect(discord?.accounts?.main?.perChannelAgent?.["123456"]).toBe("assistant");
    });

    it("loads global and agent tool settings from the same config file", async () => {
      const configPath = path.join(tempDir, "tools.yaml");
      await fs.writeFile(
        configPath,
        `
tools:
  allow:
    - read

agents:
  - id: assistant
`,
      );

      const config = await loadConfig(configPath);

      expect(config.agents[0].id).toBe("assistant");
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
    });

    it("uses defaultModel from global provider when agent has no model", () => {
      const agentFile = { id: "test" };
      const defaultProvider = { type: "openai" as const, defaultModel: "gpt-4" };

      const config = toAgentConfig(agentFile, defaultProvider);

      expect(config.model).toBe("gpt-4");
    });

    it("prefers per-agent model over provider defaultModel", () => {
      const agentFile = { id: "test", model: "claude-3" };
      const defaultProvider = { type: "openai" as const, defaultModel: "gpt-4" };

      const config = toAgentConfig(agentFile, defaultProvider);

      expect(config.model).toBe("claude-3");
    });

    it("model omitted when neither agent.model nor provider.defaultModel set", () => {
      const config = toAgentConfig({ id: "test" });
      expect(config.model).toBeUndefined();
    });

    it("merges tool settings with defaults", () => {
      const agentFile = {
        id: "test",
        tools: { allow: ["read"] },
      };
      const config = toAgentConfig(agentFile, undefined, {
        deny: ["exec"],
      });

      expect(config.toolSettings?.allow).toEqual(["read"]);
    });
  });

  describe("resolveToolSettings", () => {
    it("defaults to empty allow/deny", () => {
      expect(resolveToolSettings()).toEqual({
        allow: undefined,
        deny: undefined,
      });
    });

    it("lets agent settings override global defaults", () => {
      expect(
        resolveToolSettings(
          { allow: ["read"] },
          { allow: ["write"] },
        ),
      ).toEqual({
        allow: ["read"],
        deny: undefined,
      });
    });

    it("passes through allow list from agent config", () => {
      const result = resolveToolSettings({ allow: ["read", "ls"] });
      expect(result.allow).toEqual(["read", "ls"]);
    });

    it("passes through deny list from agent config", () => {
      const result = resolveToolSettings({ deny: ["shell", "write"] });
      expect(result.deny).toEqual(["shell", "write"]);
    });

    it("agent allow overrides default allow", () => {
      const result = resolveToolSettings(
        { allow: ["read"] },
        { allow: ["read", "shell"] },
      );
      expect(result.allow).toEqual(["read"]);
    });

    it("agent deny overrides default deny", () => {
      const result = resolveToolSettings(
        { deny: ["shell"] },
        { deny: ["shell", "write"] },
      );
      expect(result.deny).toEqual(["shell"]);
    });

    it("falls back to default allow when agent has none", () => {
      const result = resolveToolSettings(
        {},
        { allow: ["read"] },
      );
      expect(result.allow).toEqual(["read"]);
    });

    it("falls back to default deny when agent has none", () => {
      const result = resolveToolSettings(
        {},
        { deny: ["shell"] },
      );
      expect(result.deny).toEqual(["shell"]);
    });
  });

  describe("resolveSandboxConfigFromFile", () => {
    it("returns undefined when neither agent nor default config provided", () => {
      expect(resolveSandboxConfigFromFile("test-agent")).toBeUndefined();
    });

    it("resolves an agents-level sandbox config (no per-agent override)", () => {
      const config = resolveSandboxConfigFromFile("test-agent", undefined, {
        enabled: true,
        docker: { image: "custom:latest" },
      });

      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
      expect(config!.docker?.image).toBe("custom:latest");
    });

    it("resolves default sandbox config when agent has none", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        undefined,
        { enabled: true },
      );

      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
    });

    it("per-agent { enabled: false } turns off sandbox while inheriting docker from defaults", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        { enabled: false },
        { enabled: true, docker: { image: "team:latest" } },
      );

      expect(config!.enabled).toBe(false);
      expect(config!.docker?.image).toBe("team:latest");
    });

    it("per-agent docker fields override base docker fields (per-field merge)", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        { enabled: true, docker: { image: "agent-specific:latest" } },
        { enabled: true, docker: { image: "team:latest", network: "host", cpuLimit: 2 } },
      );
      // override `image` from agent, inherit `network` and `cpuLimit` from base
      expect(config!.docker?.image).toBe("agent-specific:latest");
      expect(config!.docker?.network).toBe("host");
      expect(config!.docker?.cpuLimit).toBe(2);
    });

    it("per-agent mounts concat onto base mounts", () => {
      const config = resolveSandboxConfigFromFile(
        "test-agent",
        { enabled: true, mounts: [{ host: "/agent-foo", container: "/foo" }] },
        { enabled: true, mounts: [{ host: "/base-bar", container: "/bar" }] },
      );
      expect(config!.mounts).toEqual([
        { host: "/base-bar", container: "/bar" },
        { host: "/agent-foo", container: "/foo" },
      ]);
    });
    it("propagates pidsLimit / noNewPrivileges from file", () => {
      const config = resolveSandboxConfigFromFile("test-agent", undefined, {
        enabled: true,
        docker: {
          image: "x:latest",
          pidsLimit: 512,
          noNewPrivileges: false,
        },
      });

      expect(config!.docker?.pidsLimit).toBe(512);
      expect(config!.docker?.noNewPrivileges).toBe(false);
    });
  });

  describe("loadConfig — edge cases", () => {
    it("throws when file does not exist", async () => {
      const configPath = path.join(tempDir, "nonexistent.yaml");

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it("rejects agent ids with invalid characters", async () => {
      const configPath = path.join(tempDir, "isotopes.yaml");
      await fs.writeFile(configPath, "agents:\n  - id: Agent:Dev\n");
      await expect(loadConfig(configPath)).rejects.toThrow(/Invalid agent id/);
    });

    it("accepts valid agent ids", async () => {
      const configPath = path.join(tempDir, "isotopes.yaml");
      await fs.writeFile(configPath, "agents:\n  - id: code-reviewer_v2\n");
      const config = await loadConfig(configPath);
      expect(config.agents[0].id).toBe("code-reviewer_v2");
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accounts = ((config.channels?.discord as any)?.accounts ?? {}) as Record<string, any>;
      expect(Object.keys(accounts)).toEqual(["major", "tachikoma"]);
      expect(accounts.major.token).toBe("tok-major");
      expect(accounts.tachikoma.defaultAgentId).toBe("tachikoma");
      expect(accounts.major.context?.historyTurns).toBe(10);
    });
  });
});
