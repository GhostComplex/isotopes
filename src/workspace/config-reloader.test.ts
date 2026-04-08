// src/workspace/config-reloader.test.ts — Unit tests for ConfigReloader

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { ConfigReloader } from "./config-reloader.js";
import type { IsotopesConfigFile } from "../core/config.js";

describe("ConfigReloader", () => {
  let tempDir: string;
  let configPath: string;

  // -----------------------------------------------------------------------
  // Helper to write a valid config
  // -----------------------------------------------------------------------

  function makeConfig(overrides?: Partial<IsotopesConfigFile>): IsotopesConfigFile {
    return {
      agents: [
        { id: "test-agent", name: "Test Agent" },
      ],
      ...overrides,
    };
  }

  async function writeConfig(config: IsotopesConfigFile): Promise<void> {
    await fsp.writeFile(configPath, YAML.stringify(config), "utf-8");
  }

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "isotopes-reloader-"));
    configPath = path.join(tempDir, "isotopes.yaml");
    await writeConfig(makeConfig());
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Initial config loading
  // -----------------------------------------------------------------------

  describe("initial loading", () => {
    it("loads the initial config on start", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      const config = reloader.getConfig();
      expect(config).not.toBeNull();
      expect(config!.agents).toHaveLength(1);
      expect(config!.agents[0].id).toBe("test-agent");

      reloader.stop();
    });

    it("returns null before start", () => {
      const reloader = new ConfigReloader(configPath);

      expect(reloader.getConfig()).toBeNull();
    });

    it("throws on invalid config file", async () => {
      await fsp.writeFile(configPath, "not valid yaml: [[[", "utf-8");

      const reloader = new ConfigReloader(configPath);

      await expect(reloader.start()).rejects.toThrow();
    });

    it("throws on missing agents array", async () => {
      await fsp.writeFile(configPath, YAML.stringify({ provider: {} }), "utf-8");

      const reloader = new ConfigReloader(configPath);

      await expect(reloader.start()).rejects.toThrow("agents");
    });
  });

  // -----------------------------------------------------------------------
  // Config reload on file change
  // -----------------------------------------------------------------------

  describe("reload on change", () => {
    it("reloads config when file changes", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      // Verify initial state
      expect(reloader.getConfig()!.agents[0].name).toBe("Test Agent");

      // Modify the config
      await writeConfig(
        makeConfig({
          agents: [{ id: "updated-agent", name: "Updated Agent" }],
        }),
      );

      // Wait for fs.watch + debounce
      await new Promise((r) => setTimeout(r, 500));

      const newConfig = reloader.getConfig();
      expect(newConfig!.agents[0].id).toBe("updated-agent");
      expect(newConfig!.agents[0].name).toBe("Updated Agent");

      reloader.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Listener notifications
  // -----------------------------------------------------------------------

  describe("onReload listeners", () => {
    it("notifies listeners on reload", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      const listener = vi.fn();
      reloader.onReload(listener);

      // Modify config
      await writeConfig(
        makeConfig({
          agents: [{ id: "new-agent", name: "New Agent" }],
        }),
      );

      // Wait for reload
      await new Promise((r) => setTimeout(r, 500));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: expect.arrayContaining([
            expect.objectContaining({ id: "new-agent" }),
          ]),
        }),
      );

      reloader.stop();
    });

    it("unsubscribe removes listener", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      const listener = vi.fn();
      const unsub = reloader.onReload(listener);
      unsub();

      // Modify config
      await writeConfig(
        makeConfig({
          agents: [{ id: "x", name: "X" }],
        }),
      );

      await new Promise((r) => setTimeout(r, 500));

      expect(listener).not.toHaveBeenCalled();

      reloader.stop();
    });

    it("handles errors in listeners without stopping", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      const badListener = vi.fn(() => {
        throw new Error("listener error");
      });
      const goodListener = vi.fn();

      reloader.onReload(badListener);
      reloader.onReload(goodListener);

      // Modify config
      await writeConfig(
        makeConfig({
          agents: [{ id: "y", name: "Y" }],
        }),
      );

      await new Promise((r) => setTimeout(r, 500));

      expect(badListener).toHaveBeenCalledTimes(1);
      expect(goodListener).toHaveBeenCalledTimes(1);

      reloader.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Invalid config handling
  // -----------------------------------------------------------------------

  describe("invalid config handling", () => {
    it("keeps previous config when reload fails", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      // Verify initial config is loaded
      expect(reloader.getConfig()!.agents[0].id).toBe("test-agent");

      // Write invalid config
      await fsp.writeFile(configPath, "agents: not-an-array", "utf-8");

      await new Promise((r) => setTimeout(r, 500));

      // Should still have the old valid config
      const config = reloader.getConfig();
      expect(config).not.toBeNull();
      expect(config!.agents[0].id).toBe("test-agent");

      reloader.stop();
    });

    it("does not notify listeners when reload fails", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();

      const listener = vi.fn();
      reloader.onReload(listener);

      // Write invalid config
      await fsp.writeFile(configPath, "agents: not-an-array", "utf-8");

      await new Promise((r) => setTimeout(r, 500));

      expect(listener).not.toHaveBeenCalled();

      reloader.stop();
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe("stop", () => {
    it("stops without error", async () => {
      const reloader = new ConfigReloader(configPath);
      await reloader.start();
      reloader.stop();
      // No error = pass
    });

    it("stop before start does not throw", () => {
      const reloader = new ConfigReloader(configPath);
      reloader.stop(); // should not throw
    });
  });
});
