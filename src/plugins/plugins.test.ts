import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "./hooks.js";
import { UIRegistry } from "./ui-registry.js";
import { createPluginApi } from "./api.js";
import type { PluginManifest, TransportFactory } from "./types.js";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// HookRegistry
// ---------------------------------------------------------------------------

describe("HookRegistry", () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it("emits to registered handlers", async () => {
    const handler = vi.fn();
    hooks.on("before_tool_call", handler);
    await hooks.emit("before_tool_call", { agentId: "a1", toolName: "echo", args: {} });
    expect(handler).toHaveBeenCalledWith({ agentId: "a1", toolName: "echo", args: {} });
  });

  it("unsubscribes when calling returned function", async () => {
    const handler = vi.fn();
    const unsub = hooks.on("agent_end", handler);
    unsub();
    await hooks.emit("agent_end", { agentId: "a1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs handlers sequentially", async () => {
    const order: number[] = [];
    hooks.on("session_start", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    hooks.on("session_start", () => {
      order.push(2);
    });
    await hooks.emit("session_start", { agentId: "a1", sessionId: "s1" });
    expect(order).toEqual([1, 2]);
  });

  it("clear() removes all handlers", async () => {
    const handler = vi.fn();
    hooks.on("agent_end", handler);
    hooks.clear();
    await hooks.emit("agent_end", { agentId: "a1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits to no-op when no handlers registered", async () => {
    await expect(hooks.emit("agent_end", { agentId: "a1" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UIRegistry
// ---------------------------------------------------------------------------

describe("UIRegistry", () => {
  it("registers and lists UI configs", () => {
    const registry = new UIRegistry();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    registry.register({ id: "dash", label: "Dashboard", staticDir: "/tmp/dash" });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("dash")!.mountPath).toBe("/ui/dash");
  });

  it("matches request paths", () => {
    const registry = new UIRegistry();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    registry.register({ id: "dash", label: "Dashboard", staticDir: "/tmp/dash" });
    expect(registry.match("/ui/dash")).toBeDefined();
    expect(registry.match("/ui/dash/index.html")).toBeDefined();
    expect(registry.match("/api/status")).toBeUndefined();
  });

  it("throws if staticDir does not exist", () => {
    const registry = new UIRegistry();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(() =>
      registry.register({ id: "x", label: "X", staticDir: "/nonexistent" }),
    ).toThrow("staticDir does not exist");
  });

  it("uses custom mountPath", () => {
    const registry = new UIRegistry();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    registry.register({ id: "x", label: "X", staticDir: "/tmp/x", mountPath: "/custom" });
    expect(registry.get("x")!.mountPath).toBe("/custom");
    expect(registry.match("/custom/foo")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createPluginApi
// ---------------------------------------------------------------------------

describe("createPluginApi", () => {
  const manifest: PluginManifest = {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    entry: "./index.ts",
  };

  it("registers transport and tracks cleanup", () => {
    const hooks = new HookRegistry();
    const uiRegistry = new UIRegistry();
    const transportFactories = new Map<string, TransportFactory>();

    const { api, cleanup } = createPluginApi(manifest, "/tmp/plugin", {
      hooks,
      uiRegistry,
      transportFactories,
    });

    const factory: TransportFactory = async () => ({ start: async () => {}, stop: async () => {} });
    api.registerTransport("test", factory);
    expect(transportFactories.has("test")).toBe(true);

    // Cleanup removes it
    for (const fn of cleanup) fn();
    expect(transportFactories.has("test")).toBe(false);
  });

  it("registers hook and tracks cleanup", async () => {
    const hooks = new HookRegistry();
    const uiRegistry = new UIRegistry();
    const transportFactories = new Map<string, TransportFactory>();

    const { api, cleanup } = createPluginApi(manifest, "/tmp/plugin", {
      hooks,
      uiRegistry,
      transportFactories,
    });

    const handler = vi.fn();
    api.on("agent_end", handler);
    await hooks.emit("agent_end", { agentId: "a1" });
    expect(handler).toHaveBeenCalled();

    for (const fn of cleanup) fn();
    handler.mockClear();
    await hooks.emit("agent_end", { agentId: "a1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns plugin config", () => {
    const hooks = new HookRegistry();
    const uiRegistry = new UIRegistry();
    const transportFactories = new Map<string, TransportFactory>();

    const { api } = createPluginApi(manifest, "/tmp/plugin", {
      hooks,
      uiRegistry,
      transportFactories,
      pluginConfig: { theme: "dark" },
    });

    expect(api.getConfig()).toEqual({ theme: "dark" });
  });

  it("provides a scoped logger", () => {
    const hooks = new HookRegistry();
    const uiRegistry = new UIRegistry();
    const transportFactories = new Map<string, TransportFactory>();

    const { api } = createPluginApi(manifest, "/tmp/plugin", {
      hooks,
      uiRegistry,
      transportFactories,
    });

    expect(api.log).toBeDefined();
    expect(api.log.info).toBeInstanceOf(Function);
  });
});
