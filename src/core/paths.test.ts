// src/core/paths.test.ts — Unit tests for paths module

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  getIsotopesHome,
  getLogsDir,
  getWorkspacePath,
  getAgentSessionsDir,
  normalizeAgentId,
  getConfigPath,
  getThreadBindingsPath,
  ensureDirectories,
  ensureWorkspaceDir,
  ensureExplicitWorkspaceDir,
  ensureAgentSessionsDir,
  resolveExplicitWorkspacePath,
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

  describe("normalizeAgentId", () => {
    it("lowercases and replaces unsafe chars", () => {
      expect(normalizeAgentId("Alice")).toBe("alice");
      expect(normalizeAgentId("a/b:c")).toBe("a-b-c");
    });
  });

  describe("getAgentSessionsDir", () => {
    it("returns ~/.isotopes/agents/<id>/sessions", () => {
      const expected = path.join(os.homedir(), ".isotopes", "agents", "alice", "sessions");
      expect(getAgentSessionsDir("alice")).toBe(expected);
    });

    it("normalizes the agent id segment", () => {
      const expected = path.join(os.homedir(), ".isotopes", "agents", "code-reviewer-v2", "sessions");
      expect(getAgentSessionsDir("Code:Reviewer/v2")).toBe(expected);
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

  describe("resolveExplicitWorkspacePath", () => {
    it("returns absolute paths as-is", () => {
      expect(resolveExplicitWorkspacePath("/Users/foo/workspace")).toBe("/Users/foo/workspace");
    });

    it("resolves relative paths from ISOTOPES_HOME", () => {
      vi.stubEnv("ISOTOPES_HOME", "/custom/home");
      expect(resolveExplicitWorkspacePath("./my-workspace")).toBe(
        path.resolve("/custom/home", "./my-workspace"),
      );
    });

    it("resolves bare relative paths from ISOTOPES_HOME", () => {
      vi.stubEnv("ISOTOPES_HOME", "/custom/home");
      expect(resolveExplicitWorkspacePath("agents/major")).toBe(
        path.resolve("/custom/home", "agents/major"),
      );
    });

    it("resolves relative paths from default home when ISOTOPES_HOME is unset", () => {
      const expected = path.resolve(path.join(os.homedir(), ".isotopes"), "my-workspace");
      expect(resolveExplicitWorkspacePath("my-workspace")).toBe(expected);
    });
  });

  describe("getThreadBindingsPath", () => {
    it("returns ~/.isotopes/thread-bindings.json", () => {
      const expected = path.join(os.homedir(), ".isotopes", "thread-bindings.json");
      expect(getThreadBindingsPath()).toBe(expected);
    });

    it("respects ISOTOPES_HOME", () => {
      vi.stubEnv("ISOTOPES_HOME", "/custom");
      expect(getThreadBindingsPath()).toBe("/custom/thread-bindings.json");
    });
  });

  describe("ensureDirectories", () => {
    it("creates the home and logs directories", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-paths-"));
      const home = path.join(tmp, "home");
      vi.stubEnv("ISOTOPES_HOME", home);
      try {
        await ensureDirectories();
        await expect(fs.stat(home)).resolves.toMatchObject({});
        await expect(fs.stat(path.join(home, "logs"))).resolves.toMatchObject({});
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("is idempotent — second call does not throw", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-paths-"));
      vi.stubEnv("ISOTOPES_HOME", path.join(tmp, "home"));
      try {
        await ensureDirectories();
        await expect(ensureDirectories()).resolves.toBeUndefined();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
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

  describe("ensureExplicitWorkspaceDir", () => {
    it("creates the resolved path", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-paths-"));
      const ws = path.join(tmp, "explicit-ws");
      try {
        const result = await ensureExplicitWorkspaceDir(ws);
        expect(result).toBe(ws);
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
