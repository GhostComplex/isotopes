// src/core/paths.test.ts — Unit tests for paths module

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  getIsotopesHome,
  getWorkspacesDir,
  getLogsDir,
  getWorkspacePath,
  getSessionsDir,
  getConfigPath,
  resolveWorkspacePath,
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

  describe("getConfigPath", () => {
    it("returns ~/.isotopes/isotopes.yaml", () => {
      const expected = path.join(os.homedir(), ".isotopes", "isotopes.yaml");
      expect(getConfigPath()).toBe(expected);
    });

    it("respects ISOTOPES_HOME", () => {
      vi.stubEnv("ISOTOPES_HOME", "/custom");
      expect(getConfigPath()).toBe("/custom/isotopes.yaml");
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
});
