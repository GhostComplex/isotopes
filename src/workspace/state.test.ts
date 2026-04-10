// src/workspace/state.test.ts — Unit tests for workspace state tracking

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readWorkspaceState,
  writeWorkspaceState,
  isSetupComplete,
  reconcileWorkspaceState,
} from "./state.js";

describe("Workspace State", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-state-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("readWorkspaceState", () => {
    it("returns default state when no state file exists", async () => {
      const state = await readWorkspaceState(tempDir);
      expect(state.version).toBe(1);
      expect(state.bootstrapSeededAt).toBeUndefined();
      expect(state.setupCompletedAt).toBeUndefined();
    });

    it("reads existing state file", async () => {
      await fs.mkdir(path.join(tempDir, ".isotopes"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".isotopes", "workspace-state.json"),
        JSON.stringify({
          version: 1,
          bootstrapSeededAt: "2026-04-10T00:00:00.000Z",
        }),
      );

      const state = await readWorkspaceState(tempDir);
      expect(state.bootstrapSeededAt).toBe("2026-04-10T00:00:00.000Z");
    });
  });

  describe("writeWorkspaceState", () => {
    it("writes state and creates .isotopes directory", async () => {
      const state = {
        version: 1 as const,
        bootstrapSeededAt: "2026-04-10T00:00:00.000Z",
      };

      await writeWorkspaceState(tempDir, state);

      const raw = await fs.readFile(
        path.join(tempDir, ".isotopes", "workspace-state.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.bootstrapSeededAt).toBe("2026-04-10T00:00:00.000Z");
    });

    it("roundtrips correctly", async () => {
      const state = {
        version: 1 as const,
        bootstrapSeededAt: "2026-04-10T00:00:00.000Z",
        setupCompletedAt: "2026-04-10T01:00:00.000Z",
      };

      await writeWorkspaceState(tempDir, state);
      const read = await readWorkspaceState(tempDir);

      expect(read).toEqual(state);
    });
  });

  describe("isSetupComplete", () => {
    it("returns false when setupCompletedAt is not set", () => {
      expect(isSetupComplete({ version: 1 })).toBe(false);
    });

    it("returns true when setupCompletedAt is set", () => {
      expect(
        isSetupComplete({
          version: 1,
          setupCompletedAt: "2026-04-10T00:00:00.000Z",
        }),
      ).toBe(true);
    });
  });

  describe("reconcileWorkspaceState", () => {
    it("records bootstrapSeededAt when BOOTSTRAP.md exists", async () => {
      await fs.writeFile(path.join(tempDir, "BOOTSTRAP.md"), "bootstrap content");

      const state = await reconcileWorkspaceState(tempDir);

      expect(state.bootstrapSeededAt).toBeDefined();
      expect(state.setupCompletedAt).toBeUndefined();
    });

    it("marks setupCompletedAt when BOOTSTRAP.md was seeded and then deleted", async () => {
      // Simulate: bootstrap was seeded previously
      await fs.mkdir(path.join(tempDir, ".isotopes"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".isotopes", "workspace-state.json"),
        JSON.stringify({
          version: 1,
          bootstrapSeededAt: "2026-04-10T00:00:00.000Z",
        }),
      );
      // BOOTSTRAP.md does NOT exist (agent deleted it)

      const state = await reconcileWorkspaceState(tempDir);

      expect(state.setupCompletedAt).toBeDefined();
    });

    it("detects legacy workspace (has content, no state)", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "existing soul");

      const state = await reconcileWorkspaceState(tempDir);

      expect(state.setupCompletedAt).toBeDefined();
    });

    it("does nothing for empty workspace with no bootstrap", async () => {
      const state = await reconcileWorkspaceState(tempDir);

      expect(state.bootstrapSeededAt).toBeUndefined();
      expect(state.setupCompletedAt).toBeUndefined();
    });

    it("does nothing if already completed", async () => {
      await fs.mkdir(path.join(tempDir, ".isotopes"), { recursive: true });
      const existing = {
        version: 1,
        bootstrapSeededAt: "2026-04-10T00:00:00.000Z",
        setupCompletedAt: "2026-04-10T01:00:00.000Z",
      };
      await fs.writeFile(
        path.join(tempDir, ".isotopes", "workspace-state.json"),
        JSON.stringify(existing),
      );

      const state = await reconcileWorkspaceState(tempDir);

      // Should return same state unchanged
      expect(state.setupCompletedAt).toBe("2026-04-10T01:00:00.000Z");
    });
  });
});
