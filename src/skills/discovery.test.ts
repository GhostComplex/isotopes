// src/skills/discovery.test.ts — Unit tests for skill discovery

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  discoverSkills,
  getGlobalSkillsPath,
  getWorkspaceSkillsPath,
} from "./discovery.js";

describe("Skill Discovery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-skills-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("discoverSkills", () => {
    it("discovers skills with SKILL.md files", async () => {
      // Create a skill directory with SKILL.md
      const skillDir = path.join(tempDir, "my-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: my-skill\ndescription: A test skill\n---\n\n# My Skill",
      );

      const skills = await discoverSkills({ globalPath: tempDir });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(skillDir);
      expect(skills[0].skillPath).toBe(path.join(skillDir, "SKILL.md"));
    });

    it("returns empty array for empty directory", async () => {
      const skills = await discoverSkills({ globalPath: tempDir });

      expect(skills).toEqual([]);
    });

    it("returns empty array for non-existent directory", async () => {
      const nonExistent = path.join(tempDir, "does-not-exist");

      const skills = await discoverSkills({ globalPath: nonExistent });

      expect(skills).toEqual([]);
    });

    it("discovers nested skills recursively", async () => {
      // Create nested skill structure
      const level1 = path.join(tempDir, "level1");
      const level2 = path.join(level1, "level2");
      const level3 = path.join(level2, "level3");

      await fs.mkdir(level3, { recursive: true });

      // Skill at level 1
      await fs.writeFile(path.join(level1, "SKILL.md"), "# Level 1 Skill");

      // Skill at level 3
      await fs.writeFile(path.join(level3, "SKILL.md"), "# Level 3 Skill");

      const skills = await discoverSkills({ globalPath: tempDir });

      expect(skills).toHaveLength(2);
      const directories = skills.map((s) => s.directory);
      expect(directories).toContain(level1);
      expect(directories).toContain(level3);
    });

    it("ignores node_modules and .git directories", async () => {
      // Create skill in node_modules (should be ignored)
      const nodeModulesSkill = path.join(tempDir, "node_modules", "some-skill");
      await fs.mkdir(nodeModulesSkill, { recursive: true });
      await fs.writeFile(path.join(nodeModulesSkill, "SKILL.md"), "# Ignored");

      // Create skill in .git (should be ignored)
      const gitSkill = path.join(tempDir, ".git", "hooks");
      await fs.mkdir(gitSkill, { recursive: true });
      await fs.writeFile(path.join(gitSkill, "SKILL.md"), "# Ignored");

      // Create valid skill
      const validSkill = path.join(tempDir, "valid-skill");
      await fs.mkdir(validSkill, { recursive: true });
      await fs.writeFile(path.join(validSkill, "SKILL.md"), "# Valid");

      const skills = await discoverSkills({ globalPath: tempDir });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(validSkill);
    });

    it("ignores directories without SKILL.md", async () => {
      // Create directory without SKILL.md
      const noSkillDir = path.join(tempDir, "not-a-skill");
      await fs.mkdir(noSkillDir, { recursive: true });
      await fs.writeFile(path.join(noSkillDir, "README.md"), "# Not a skill");

      // Create directory with SKILL.md
      const skillDir = path.join(tempDir, "actual-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill");

      const skills = await discoverSkills({ globalPath: tempDir });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(skillDir);
    });

    it("scans workspace skills directory", async () => {
      // Create workspace structure
      const workspacePath = path.join(tempDir, "workspace");
      const workspaceSkillsDir = path.join(workspacePath, "skills");
      const skillDir = path.join(workspaceSkillsDir, "workspace-skill");

      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Workspace Skill");

      const skills = await discoverSkills({
        globalPath: path.join(tempDir, "empty"), // Non-existent, should be skipped
        workspacePath,
      });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(skillDir);
    });

    it("scans additional paths", async () => {
      const additionalDir = path.join(tempDir, "custom-skills");
      const skillDir = path.join(additionalDir, "custom-skill");

      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Custom Skill");

      const skills = await discoverSkills({
        globalPath: path.join(tempDir, "empty"),
        additionalPaths: [additionalDir],
      });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(skillDir);
    });

    it("deduplicates skills by directory", async () => {
      // Create a skill
      const skillDir = path.join(tempDir, "shared-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Shared Skill");

      // Scan the same path twice via additionalPaths
      const skills = await discoverSkills({
        globalPath: tempDir,
        additionalPaths: [tempDir],
      });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(skillDir);
    });

    it("discovers skills from multiple paths in order", async () => {
      // Create global skill
      const globalDir = path.join(tempDir, "global");
      const globalSkill = path.join(globalDir, "global-skill");
      await fs.mkdir(globalSkill, { recursive: true });
      await fs.writeFile(path.join(globalSkill, "SKILL.md"), "# Global");

      // Create workspace skill
      const workspaceDir = path.join(tempDir, "workspace");
      const workspaceSkillsDir = path.join(workspaceDir, "skills");
      const workspaceSkill = path.join(workspaceSkillsDir, "workspace-skill");
      await fs.mkdir(workspaceSkill, { recursive: true });
      await fs.writeFile(path.join(workspaceSkill, "SKILL.md"), "# Workspace");

      // Create additional skill
      const additionalDir = path.join(tempDir, "additional");
      const additionalSkill = path.join(additionalDir, "additional-skill");
      await fs.mkdir(additionalSkill, { recursive: true });
      await fs.writeFile(path.join(additionalSkill, "SKILL.md"), "# Additional");

      const skills = await discoverSkills({
        globalPath: globalDir,
        workspacePath: workspaceDir,
        additionalPaths: [additionalDir],
      });

      expect(skills).toHaveLength(3);
      // Verify order: global, workspace, additional
      expect(skills[0].directory).toBe(globalSkill);
      expect(skills[1].directory).toBe(workspaceSkill);
      expect(skills[2].directory).toBe(additionalSkill);
    });

    it("handles mixed existing and non-existing paths", async () => {
      // Create one valid skill
      const validDir = path.join(tempDir, "valid");
      const skillDir = path.join(validDir, "my-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Valid Skill");

      const skills = await discoverSkills({
        globalPath: path.join(tempDir, "nonexistent1"),
        workspacePath: path.join(tempDir, "nonexistent2"),
        additionalPaths: [validDir, path.join(tempDir, "nonexistent3")],
      });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(skillDir);
    });

    it("discovers skill at root of scanned directory", async () => {
      // SKILL.md directly in the scanned path
      await fs.writeFile(path.join(tempDir, "SKILL.md"), "# Root Skill");

      const skills = await discoverSkills({ globalPath: tempDir });

      expect(skills).toHaveLength(1);
      expect(skills[0].directory).toBe(tempDir);
    });
  });

  describe("getGlobalSkillsPath", () => {
    it("returns path under isotopes home", () => {
      const result = getGlobalSkillsPath();
      expect(result).toContain("skills");
      expect(result).toContain(".isotopes");
    });
  });

  describe("getWorkspaceSkillsPath", () => {
    it("returns skills subdirectory of workspace", () => {
      const result = getWorkspaceSkillsPath("/path/to/workspace");
      expect(result).toBe("/path/to/workspace/skills");
    });
  });
});
