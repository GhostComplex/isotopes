// src/skills/skill-loader.test.ts — Unit tests for SkillLoader

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillLoader } from "./skill-loader.js";

describe("SkillLoader", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temporary directory for test skills
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-loader-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createSkill(
    name: string,
    content: string,
    subdir?: string,
  ): Promise<string> {
    const skillDir = subdir
      ? path.join(tempDir, subdir, name)
      : path.join(tempDir, name);
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillPath, content);
    return skillPath;
  }

  describe("load()", () => {
    it("loads skills from a directory", async () => {
      await createSkill(
        "test-skill",
        `---
name: test-skill
description: A test skill
---

# Test Skill

This is a test.`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const result = await loader.load();

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("test-skill");
      expect(result.skills[0].description).toBe("A test skill");
      expect(result.errors).toHaveLength(0);
    });

    it("loads multiple skills", async () => {
      await createSkill(
        "skill-one",
        `---
name: skill-one
description: First skill
---
Content`,
      );

      await createSkill(
        "skill-two",
        `---
name: skill-two
description: Second skill
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const result = await loader.load();

      expect(result.skills).toHaveLength(2);
      const names = result.skills.map((s) => s.name).sort();
      expect(names).toEqual(["skill-one", "skill-two"]);
    });

    it("collects errors for invalid skills", async () => {
      // Valid skill
      await createSkill(
        "valid-skill",
        `---
name: valid-skill
description: Valid
---
Content`,
      );

      // Invalid skill (missing description)
      await createSkill(
        "invalid-skill",
        `---
name: invalid-skill
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const result = await loader.load();

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("valid-skill");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("description");
    });

    it("collects warnings for skills with validation issues", async () => {
      // Skill with invalid name format (warning, not error)
      await createSkill(
        "bad-name",
        `---
name: BadName
description: Has invalid name
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const result = await loader.load();

      // Still loads successfully
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("BadName");
      // But has warning
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].warning).toContain("Invalid name format");
    });

    it("returns empty result for non-existent directory", async () => {
      const loader = new SkillLoader({
        globalPath: "/non/existent/path",
        logWarnings: false,
      });
      const result = await loader.load();

      expect(result.skills).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("logs warnings by default", async () => {
      await createSkill(
        "warning-skill",
        `---
name: BadName
description: Has invalid name
---
Content`,
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const loader = new SkillLoader({
        globalPath: tempDir,
        // logWarnings defaults to true
      });
      await loader.load();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toContain("[skills]");

      warnSpy.mockRestore();
    });

    it("does not log warnings when logWarnings is false", async () => {
      await createSkill(
        "warning-skill",
        `---
name: BadName
description: Has invalid name
---
Content`,
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      await loader.load();

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe("caching", () => {
    it("caches result after first load", async () => {
      await createSkill(
        "cached-skill",
        `---
name: cached-skill
description: Will be cached
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });

      const result1 = await loader.load();
      const result2 = await loader.load();

      // Should be the exact same object reference
      expect(result1).toBe(result2);
    });

    it("clearCache() forces re-scan on next load", async () => {
      await createSkill(
        "initial-skill",
        `---
name: initial-skill
description: Initial
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });

      const result1 = await loader.load();
      expect(result1.skills).toHaveLength(1);

      // Add another skill
      await createSkill(
        "new-skill",
        `---
name: new-skill
description: New
---
Content`,
      );

      // Still returns cached result
      const result2 = await loader.load();
      expect(result2.skills).toHaveLength(1);

      // Clear cache and reload
      loader.clearCache();
      const result3 = await loader.load();
      expect(result3.skills).toHaveLength(2);
    });
  });

  describe("getSkills()", () => {
    it("returns skills array", async () => {
      await createSkill(
        "get-skill",
        `---
name: get-skill
description: For getSkills test
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const skills = await loader.getSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("get-skill");
    });

    it("only returns successfully loaded skills", async () => {
      await createSkill(
        "valid",
        `---
name: valid
description: Valid skill
---
Content`,
      );

      await createSkill(
        "invalid",
        `---
name: invalid
---
Missing description`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const skills = await loader.getSkills();

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("valid");
    });

    it("uses cached result", async () => {
      await createSkill(
        "cache-test",
        `---
name: cache-test
description: Test
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });

      // First call loads
      const skills1 = await loader.getSkills();
      // Second call uses cache
      const skills2 = await loader.getSkills();

      expect(skills1).toBe(skills2);
    });
  });

  describe("generatePrompt()", () => {
    it("generates XML prompt by default", async () => {
      await createSkill(
        "prompt-skill",
        `---
name: prompt-skill
description: For prompt test
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const prompt = await loader.generatePrompt();

      expect(prompt).toContain("## Skills");
      expect(prompt).toContain("<available_skills>");
      expect(prompt).toContain("<name>prompt-skill</name>");
    });

    it("supports format option", async () => {
      await createSkill(
        "format-skill",
        `---
name: format-skill
description: For format test
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const prompt = await loader.generatePrompt({ format: "json" });

      expect(prompt).toContain('"available_skills"');
      expect(prompt).toContain('"name": "format-skill"');
    });

    it("returns empty string when no skills", async () => {
      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const prompt = await loader.generatePrompt();

      expect(prompt).toBe("");
    });

    it("supports includeInstructions option", async () => {
      await createSkill(
        "no-instr-skill",
        `---
name: no-instr-skill
description: Test
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const prompt = await loader.generatePrompt({ includeInstructions: false });

      expect(prompt).not.toContain("## Skills");
      expect(prompt).toContain("<available_skills>");
    });
  });

  describe("LoadedSkill structure", () => {
    it("includes location and directory fields", async () => {
      const skillPath = await createSkill(
        "struct-skill",
        `---
name: struct-skill
description: Structure test
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const skills = await loader.getSkills();

      expect(skills[0].location).toBe(skillPath);
      expect(skills[0].directory).toBe(path.dirname(skillPath));
    });

    it("preserves raw metadata", async () => {
      await createSkill(
        "raw-skill",
        `---
name: raw-skill
description: Raw test
customField: customValue
---
Content`,
      );

      const loader = new SkillLoader({
        globalPath: tempDir,
        logWarnings: false,
      });
      const skills = await loader.getSkills();

      expect(skills[0].raw).toBeDefined();
      expect(skills[0].raw?.customField).toBe("customValue");
    });
  });

  describe("workspace path integration", () => {
    it("loads skills from workspace path", async () => {
      const workspaceDir = path.join(tempDir, "workspace");
      const skillsDir = path.join(workspaceDir, "skills");
      await fs.mkdir(skillsDir, { recursive: true });

      await createSkill("ws-skill", `---
name: ws-skill
description: Workspace skill
---
Content`, "workspace/skills");

      const loader = new SkillLoader({
        globalPath: "/non/existent", // No global skills
        workspacePath: workspaceDir,
        logWarnings: false,
      });
      const result = await loader.load();

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("ws-skill");
    });

    it("merges skills from global and workspace", async () => {
      // Create global skill
      await createSkill(
        "global-skill",
        `---
name: global-skill
description: Global
---
Content`,
      );

      // Create workspace skill
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      await createSkill("ws-skill", `---
name: ws-skill
description: Workspace
---
Content`, "workspace/skills");

      const loader = new SkillLoader({
        globalPath: tempDir,
        workspacePath: workspaceDir,
        logWarnings: false,
      });
      const result = await loader.load();

      expect(result.skills).toHaveLength(2);
      const names = result.skills.map((s) => s.name).sort();
      expect(names).toEqual(["global-skill", "ws-skill"]);
    });
  });
});
