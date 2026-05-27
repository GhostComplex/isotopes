// src/paths.test.ts — Unit tests for paths module

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  getIsotopesHome,
  getLogsDir,
  getWorkspacePath,
  getAgentSessionsDir,
  getConfigPath,
  ensureWorkspaceDir,
  resolveBuiltinSkillsDir,
  ensureAgentSessionsDir,
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
    it("returns ~/.isotopes/workspace-{id} for any agent", () => {
      expect(getWorkspacePath("default")).toBe(
        path.join(os.homedir(), ".isotopes", "workspace-default"),
      );
      expect(getWorkspacePath("main")).toBe(
        path.join(os.homedir(), ".isotopes", "workspace-main"),
      );
    });
  });

  describe("getAgentSessionsDir", () => {
    it("returns ~/.isotopes/agents/<id>/sessions", () => {
      const expected = path.join(os.homedir(), ".isotopes", "agents", "alice", "sessions");
      expect(getAgentSessionsDir("alice")).toBe(expected);
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

  describe("ensureWorkspaceDir", () => {
    it("creates workspace-{id} dir and returns its path", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-paths-"));
      const home = path.join(tmp, "home");
      vi.stubEnv("ISOTOPES_HOME", home);
      try {
        const ws = await ensureWorkspaceDir("default");
        expect(ws).toBe(path.join(home, "workspace-default"));
        await expect(fs.stat(ws)).resolves.toMatchObject({});
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("creates workspace-{id} for named agents", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-paths-"));
      const home = path.join(tmp, "home");
      vi.stubEnv("ISOTOPES_HOME", home);
      try {
        const ws = await ensureWorkspaceDir("assistant");
        expect(ws).toBe(path.join(home, "workspace-assistant"));
        await expect(fs.stat(ws)).resolves.toMatchObject({});
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("ensureAgentSessionsDir", () => {
    it("creates ~/.isotopes/agents/<id>/sessions and returns it", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-paths-"));
      const home = path.join(tmp, "home");
      vi.stubEnv("ISOTOPES_HOME", home);
      try {
        const dir = await ensureAgentSessionsDir("alice");
        expect(dir).toBe(path.join(home, "agents", "alice", "sessions"));
        await expect(fs.stat(dir)).resolves.toMatchObject({});
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("resolveBuiltinSkillsDir", () => {
  it("returns a path ending in 'skills' when the package root has a skills dir", () => {
    const result = resolveBuiltinSkillsDir();
    if (result !== undefined) expect(path.basename(result)).toBe("skills");
  });

  it("returns the skills dir relative to the package root", () => {
    const result = resolveBuiltinSkillsDir();
    expect(result).toBeDefined();
    expect(existsSync(result!)).toBe(true);
    expect(existsSync(path.join(path.dirname(result!), "package.json"))).toBe(true);
  });
});
