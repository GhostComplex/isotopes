// src/core/agent-manager.test.ts — Unit tests for DefaultAgentManager

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultAgentManager } from "./agent-manager.js";
import type { AgentConfig, AgentCore, AgentInstance } from "./types.js";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

function createMockInstance(): AgentInstance {
  return {
    prompt: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
  };
}

function createMockCore(): AgentCore {
  return {
    createAgent: vi.fn(() => createMockInstance()),
  };
}

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    systemPrompt: "You are a test agent.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultAgentManager", () => {
  let core: AgentCore;
  let manager: DefaultAgentManager;

  beforeEach(() => {
    core = createMockCore();
    manager = new DefaultAgentManager(core);
  });

  describe("create", () => {
    it("creates and returns an agent instance", async () => {
      const config = makeConfig();
      const instance = await manager.create(config);

      expect(instance).toBeDefined();
      expect(core.createAgent).toHaveBeenCalledWith(config);
    });

    it("stores the agent config", async () => {
      const config = makeConfig();
      await manager.create(config);

      const configs = manager.list();
      expect(configs).toHaveLength(1);
      expect(configs[0]).toEqual(config);
    });

    it("throws if agent already exists", async () => {
      const config = makeConfig();
      await manager.create(config);

      await expect(manager.create(config)).rejects.toThrow(
        'Agent "test-agent" already exists',
      );
    });
  });

  describe("get", () => {
    it("returns instance for existing agent", async () => {
      const config = makeConfig();
      const created = await manager.create(config);

      const retrieved = manager.get("test-agent");
      expect(retrieved).toBe(created);
    });

    it("returns undefined for non-existent agent", () => {
      const result = manager.get("non-existent");
      expect(result).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns empty array initially", () => {
      expect(manager.list()).toEqual([]);
    });

    it("returns all agent configs", async () => {
      await manager.create(makeConfig({ id: "agent-1", name: "Agent 1" }));
      await manager.create(makeConfig({ id: "agent-2", name: "Agent 2" }));

      const configs = manager.list();
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.id)).toEqual(["agent-1", "agent-2"]);
    });
  });

  describe("update", () => {
    it("updates agent config and recreates instance", async () => {
      const config = makeConfig();
      await manager.create(config);

      const updated = await manager.update("test-agent", {
        name: "Updated Agent",
      });

      expect(updated).toBeDefined();
      expect(core.createAgent).toHaveBeenCalledTimes(2);

      const configs = manager.list();
      expect(configs[0].name).toBe("Updated Agent");
    });

    it("preserves id even if update tries to change it", async () => {
      await manager.create(makeConfig());

      await manager.update("test-agent", {
        id: "different-id",
        name: "Updated",
      } as Partial<AgentConfig>);

      const configs = manager.list();
      expect(configs[0].id).toBe("test-agent");
    });

    it("throws if agent not found", async () => {
      await expect(
        manager.update("non-existent", { name: "New Name" }),
      ).rejects.toThrow('Agent "non-existent" not found');
    });
  });

  describe("delete", () => {
    it("removes agent from manager", async () => {
      await manager.create(makeConfig());
      await manager.delete("test-agent");

      expect(manager.get("test-agent")).toBeUndefined();
      expect(manager.list()).toHaveLength(0);
    });

    it("throws if agent not found", async () => {
      await expect(manager.delete("non-existent")).rejects.toThrow(
        'Agent "non-existent" not found',
      );
    });
  });

  describe("getPrompt / updatePrompt", () => {
    it("getPrompt returns system prompt", async () => {
      await manager.create(makeConfig({ systemPrompt: "Hello world" }));

      const prompt = await manager.getPrompt("test-agent");
      expect(prompt).toBe("Hello world");
    });

    it("updatePrompt updates the system prompt", async () => {
      await manager.create(makeConfig());
      await manager.updatePrompt("test-agent", "New prompt");

      const prompt = await manager.getPrompt("test-agent");
      expect(prompt).toBe("New prompt");
    });

    it("throws if agent not found", async () => {
      await expect(manager.getPrompt("non-existent")).rejects.toThrow(
        'Agent "non-existent" not found',
      );
    });
  });
});
