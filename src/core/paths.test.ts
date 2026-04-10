// src/core/paths.test.ts — Unit tests for paths module

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  getIsotopesHome,
  getLogsDir,
  getWorkspacePath,
  getSessionsDir,
  getConfigPath,
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

  describe("getLogsDir", () => {
    it("returns ~/.isotopes/logs", () => {
      const expected = path.join(os.homedir(), ".isotopes", "logs");
      expect(getLogsDir()).toBe(expected);
    });
  });

  describe("getWorkspacePath", () => {
    it("returns ~/.isotopes/workspace for default agent", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspace");
      expect(getWorkspacePath("default")).toBe(expected);
    });

    it("returns ~/.isotopes/workspace-{id} for named agent", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspace-assistant");
      expect(getWorkspacePath("assistant")).toBe(expected);
    });
  });

  describe("getSessionsDir", () => {
    it("returns sessions dir inside default workspace", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspace", "sessions");
      expect(getSessionsDir("default")).toBe(expected);
    });

    it("returns sessions dir inside named workspace", () => {
      const expected = path.join(os.homedir(), ".isotopes", "workspace-assistant", "sessions");
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
});
