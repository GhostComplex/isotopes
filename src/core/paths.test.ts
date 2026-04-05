// src/core/paths.test.ts — Unit tests for paths module

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  getIsotopesHome,
  getWorkspacesDir,
  getLogsDir,
  getWorkspacePath,
  getSessionsDir,
  resolveWorkspacePath,
  findConfigFile,
} from "./paths.js";

describe("paths", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getIsotopesHome", () => {
    it("returns ~/.isotopes by default", () => {
      const expected = path.join(os.homedir(), ".isotopes");
      expect(getIsotopesHome()).toBe(expected);
    });

    it("respects ISOTOPES_HOME env var", () => {
      vi.stubEnv("ISOTOPES_HOME", "/custom/path");
      expect(getIsotopesHome()).toBe("/custom/path");
    });
  });

  describe("getWorkspacesDir", () => {
    it("returns ~/.isotopes/workspaces", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspaces");
      expect(getWorkspacesDir()).toBe(expected);
    });
  });

  describe("getLogsDir", () => {
    it("returns ~/.isotopes/logs", () => {
      const expected = path.join(os.homedir(), ".isotopes", "logs");
      expect(getLogsDir()).toBe(expected);
    });
  });

  describe("getWorkspacePath", () => {
    it("returns workspace path for agent", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspaces", "assistant");
      expect(getWorkspacePath("assistant")).toBe(expected);
    });
  });

  describe("getSessionsDir", () => {
    it("returns sessions dir inside workspace", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspaces", "assistant", "sessions");
      expect(getSessionsDir("assistant")).toBe(expected);
    });
  });

  describe("resolveWorkspacePath", () => {
    it("returns absolute path as-is", () => {
      expect(resolveWorkspacePath("/absolute/path")).toBe("/absolute/path");
    });

    it("resolves relative path to workspaces dir", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspaces", "my-agent");
      expect(resolveWorkspacePath("my-agent")).toBe(expected);
    });

    it("handles nested relative paths", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspaces", "team", "agent");
      expect(resolveWorkspacePath("team/agent")).toBe(expected);
    });
  });

  describe("findConfigFile", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("throws error when explicit path does not exist", async () => {
      const nonExistentPath = path.join(tempDir, "nonexistent.yaml");
      
      await expect(findConfigFile(nonExistentPath)).rejects.toThrow(
        `Config file not found: ${nonExistentPath}`
      );
    });

    it("returns explicit path when it exists", async () => {
      const configPath = path.join(tempDir, "custom.yaml");
      await fs.writeFile(configPath, "agents: []");

      const result = await findConfigFile(configPath);

      expect(result).toBe(configPath);
    });

    it("returns null when no config found and no explicit path", async () => {
      // Point to temp dir with no config
      vi.stubEnv("ISOTOPES_HOME", tempDir);
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      try {
        const result = await findConfigFile();
        expect(result).toBeNull();
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
