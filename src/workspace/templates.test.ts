// src/workspace/templates.test.ts — Unit tests for workspace template seeding

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  seedWorkspaceTemplates,
  getWorkspaceTemplates,
  isBrandNewWorkspace,
} from "./templates.js";

describe("Workspace Templates", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-templates-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getWorkspaceTemplates", () => {
    it("returns 6 templates", () => {
      const templates = getWorkspaceTemplates();
      expect(templates).toHaveLength(6);
    });

    it("marks BOOTSTRAP.md as firstRunOnly", () => {
      const templates = getWorkspaceTemplates();
      const bootstrap = templates.find((t) => t.filename === "BOOTSTRAP.md");
      expect(bootstrap).toBeDefined();
      expect(bootstrap!.firstRunOnly).toBe(true);
    });

    it("does not mark other templates as firstRunOnly", () => {
      const templates = getWorkspaceTemplates();
      const nonBootstrap = templates.filter((t) => t.filename !== "BOOTSTRAP.md");
      for (const tmpl of nonBootstrap) {
        expect(tmpl.firstRunOnly).toBeFalsy();
      }
    });
  });

  describe("isBrandNewWorkspace", () => {
    it("returns true for empty directory", async () => {
      expect(await isBrandNewWorkspace(tempDir)).toBe(true);
    });

    it("returns false when SOUL.md exists", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "content");
      expect(await isBrandNewWorkspace(tempDir)).toBe(false);
    });

    it("returns false when MEMORY.md exists", async () => {
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "content");
      expect(await isBrandNewWorkspace(tempDir)).toBe(false);
    });

    it("returns false when daily memory files exist", async () => {
      await fs.mkdir(path.join(tempDir, "memory"));
      await fs.writeFile(path.join(tempDir, "memory", "2026-04-10.md"), "notes");
      expect(await isBrandNewWorkspace(tempDir)).toBe(false);
    });

    it("returns true when memory dir exists but is empty", async () => {
      await fs.mkdir(path.join(tempDir, "memory"));
      expect(await isBrandNewWorkspace(tempDir)).toBe(true);
    });
  });

  describe("seedWorkspaceTemplates", () => {
    it("seeds all templates into empty workspace", async () => {
      const created = await seedWorkspaceTemplates(tempDir);

      expect(created).toHaveLength(6);
      expect(created).toContain("SOUL.md");
      expect(created).toContain("IDENTITY.md");
      expect(created).toContain("USER.md");
      expect(created).toContain("TOOLS.md");
      expect(created).toContain("AGENTS.md");
      expect(created).toContain("BOOTSTRAP.md");

      // Verify files exist with content
      const soul = await fs.readFile(path.join(tempDir, "SOUL.md"), "utf-8");
      expect(soul).toContain("Your Core");
    });

    it("never overwrites existing files", async () => {
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "My custom soul");

      const created = await seedWorkspaceTemplates(tempDir);

      // SOUL.md should NOT be in the created list
      expect(created).not.toContain("SOUL.md");

      // Original content preserved
      const soul = await fs.readFile(path.join(tempDir, "SOUL.md"), "utf-8");
      expect(soul).toBe("My custom soul");
    });

    it("skips BOOTSTRAP.md for non-brand-new workspaces", async () => {
      // Create an existing file to make it non-brand-new
      await fs.writeFile(path.join(tempDir, "SOUL.md"), "Existing soul");

      const created = await seedWorkspaceTemplates(tempDir);

      // BOOTSTRAP.md should be skipped (workspace not brand new)
      expect(created).not.toContain("BOOTSTRAP.md");
      // SOUL.md should be skipped (already exists)
      expect(created).not.toContain("SOUL.md");
      // Other templates should be created
      expect(created).toContain("IDENTITY.md");
      expect(created).toContain("USER.md");
    });

    it("seeds BOOTSTRAP.md for brand-new workspaces", async () => {
      const created = await seedWorkspaceTemplates(tempDir);

      expect(created).toContain("BOOTSTRAP.md");
      const bootstrap = await fs.readFile(path.join(tempDir, "BOOTSTRAP.md"), "utf-8");
      expect(bootstrap).toContain("First Boot");
    });

    it("BOOTSTRAP.md contains anti-hallucination guard", async () => {
      await seedWorkspaceTemplates(tempDir);

      const bootstrap = await fs.readFile(path.join(tempDir, "BOOTSTRAP.md"), "utf-8");
      expect(bootstrap).toContain("MUST read your IDENTITY.md file");
      expect(bootstrap).toContain("Do NOT fabricate identity");
    });

    it("is idempotent — second call creates nothing", async () => {
      await seedWorkspaceTemplates(tempDir);
      const created = await seedWorkspaceTemplates(tempDir);

      expect(created).toHaveLength(0);
    });
  });
});
