// src/core/pi-mono.test.ts — Unit tests for PiMonoCore
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

function createDefaultMockModel() {
  return {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn().mockImplementation(() => createDefaultMockModel()),
}));

import { getModel } from "@mariozechner/pi-ai";
import { PiMonoCore, resolveModel } from "./pi-mono.js";
import { ToolRegistry } from "./tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "test-agent",
    systemPrompt: "You are a test agent.",
    ...overrides,
  };
}

function resetMocks() {
  vi.mocked(getModel).mockReset().mockImplementation((() => createDefaultMockModel()) as unknown as typeof getModel);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  beforeEach(resetMocks);

  it("resolves default anthropic model", () => {
    const model = resolveModel(makeConfig());
    expect(model).toBeDefined();
    expect(model.provider).toBe("anthropic");
  });

  it("applies proxy baseUrl override", () => {
    const model = resolveModel(makeConfig({
      provider: {
        type: "anthropic-proxy",
        baseUrl: "https://copilot-portal.azurewebsites.net",
        model: "claude-opus-4.5",
      },
    }));
    expect(model.baseUrl).toBe("https://copilot-portal.azurewebsites.net");
  });

  it("injects Authorization header for anthropic-proxy with apiKey", () => {
    const model = resolveModel(makeConfig({
      provider: {
        type: "anthropic-proxy",
        baseUrl: "https://proxy.example.com",
        model: "claude-opus-4.5",
        apiKey: "proxy-token",
      },
    }));
    expect(model.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer proxy-token",
    }));
  });

  it("merges configured proxy headers with existing model headers", () => {
    vi.mocked(getModel).mockImplementationOnce((() => ({
      ...createDefaultMockModel(),
      headers: { "X-Model-Header": "base" },
    })) as unknown as typeof getModel);

    const model = resolveModel(makeConfig({
      provider: {
        type: "anthropic-proxy",
        baseUrl: "https://proxy.example.com",
        model: "claude-opus-4.5",
        apiKey: "proxy-token",
        headers: { "X-Proxy-Header": "override" },
      },
    }));
    expect(model.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer proxy-token",
      "X-Model-Header": "base",
      "X-Proxy-Header": "override",
    }));
  });

  it("falls back to dashed variant for dotted anthropic model ids", () => {
    vi.mocked(getModel).mockImplementation(((provider: string, modelId: string) => {
      if (provider === "anthropic" && modelId === "claude-opus-4-5") {
        return { ...createDefaultMockModel(), id: "claude-opus-4-5" };
      }
      return undefined;
    }) as typeof getModel);

    const model = resolveModel(makeConfig({
      provider: {
        type: "anthropic-proxy",
        baseUrl: "https://proxy.example.com",
        model: "claude-opus-4.5",
      },
    }));
    expect(model.id).toBe("claude-opus-4.5");
  });
});

describe("PiMonoCore", () => {
  beforeEach(resetMocks);

  it("createServiceCache returns an AgentServiceCache", () => {
    const core = new PiMonoCore();
    const cache = core.createServiceCache(makeConfig());
    expect(cache).toBeDefined();
    expect(cache.model).toBeDefined();
    expect(cache.customTools).toEqual([]);
  });

  it("binds tool registries per agent", () => {
    const core = new PiMonoCore();

    const registryA = new ToolRegistry("test");
    registryA.register(
      { name: "read_file", description: "Read file", parameters: {} },
      async () => "a",
    );

    const registryB = new ToolRegistry("test");
    registryB.register(
      { name: "list_dir", description: "List dir", parameters: {} },
      async () => "b",
    );

    core.setToolRegistry("agent-a", registryA);
    core.setToolRegistry("agent-b", registryB);

    const cacheA = core.createServiceCache(makeConfig({ id: "agent-a" }));
    const cacheB = core.createServiceCache(makeConfig({ id: "agent-b" }));

    expect(cacheA.customTools).toHaveLength(1);
    expect(cacheA.customTools[0].name).toBe("read_file");
    expect(cacheB.customTools).toHaveLength(1);
    expect(cacheB.customTools[0].name).toBe("list_dir");
  });

  it("clearToolRegistry removes binding", () => {
    const core = new PiMonoCore();
    const registry = new ToolRegistry("test");
    registry.register(
      { name: "read_file", description: "Read file", parameters: {} },
      async () => "a",
    );
    core.setToolRegistry("agent-a", registry);
    core.clearToolRegistry("agent-a");

    const cache = core.createServiceCache(makeConfig({ id: "agent-a" }));
    expect(cache.customTools).toHaveLength(0);
  });
});
