// src/skills/parser.test.ts — Unit tests for SKILL.md parser

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseSkillFile,
  parseFrontmatter,
  validateSkillName,
} from "./parser.js";

describe("Skill Parser", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-parser-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("validateSkillName", () => {
    it("accepts valid names", () => {
      expect(validateSkillName("my-skill")).toEqual({ valid: true });
      expect(validateSkillName("web-search")).toEqual({ valid: true });
      expect(validateSkillName("github-issues")).toEqual({ valid: true });
      expect(validateSkillName("pdf-tools")).toEqual({ valid: true });
      expect(validateSkillName("a")).toEqual({ valid: true });
      expect(validateSkillName("skill123")).toEqual({ valid: true });
      expect(validateSkillName("a1b2c3")).toEqual({ valid: true });
    });

    it("rejects empty name", () => {
      const result = validateSkillName("");
      expect(result.valid).toBe(false);
      expect(result.message).toContain("empty");
    });

    it("rejects name exceeding 64 characters", () => {
      const longName = "a".repeat(65);
      const result = validateSkillName(longName);
      expect(result.valid).toBe(false);
      expect(result.message).toContain("64");
    });

    it("rejects uppercase letters", () => {
      const result = validateSkillName("MySkill");
      expect(result.valid).toBe(false);
      expect(result.message).toContain("lowercase");
    });

    it("rejects leading hyphen", () => {
      const result = validateSkillName("-skill");
      expect(result.valid).toBe(false);
    });

    it("rejects trailing hyphen", () => {
      const result = validateSkillName("skill-");
      expect(result.valid).toBe(false);
    });

    it("rejects consecutive hyphens", () => {
      const result = validateSkillName("my--skill");
      expect(result.valid).toBe(false);
    });

    it("rejects underscores", () => {
      const result = validateSkillName("my_skill");
      expect(result.valid).toBe(false);
    });

    it("rejects spaces", () => {
      const result = validateSkillName("my skill");
      expect(result.valid).toBe(false);
    });

    it("rejects non-string input", () => {
      const result = validateSkillName(123 as unknown as string);
      expect(result.valid).toBe(false);
      expect(result.message).toContain("string");
    });
  });

  describe("parseFrontmatter", () => {
    it("parses valid frontmatter", () => {
      const content = `---
name: my-skill
description: A test skill for doing things
---

# My Skill

Instructions here.`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.name).toBe("my-skill");
      expect(result.metadata?.description).toBe("A test skill for doing things");
      expect(result.metadata?.raw).toEqual({
        name: "my-skill",
        description: "A test skill for doing things",
      });
      expect(result.warnings).toBeUndefined();
    });

    it("preserves extra frontmatter fields in raw", () => {
      const content = `---
name: my-skill
description: A test skill
version: 1.0.0
author: Test Author
---

# Content`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(true);
      expect(result.metadata?.raw).toEqual({
        name: "my-skill",
        description: "A test skill",
        version: "1.0.0",
        author: "Test Author",
      });
    });

    it("returns error for missing frontmatter", () => {
      const content = `# My Skill

No frontmatter here.`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No frontmatter found");
    });

    it("returns error for missing name", () => {
      const content = `---
description: A skill without a name
---

# Content`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required field: name");
    });

    it("returns error for missing description", () => {
      const content = `---
name: my-skill
---

# Content`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required field: description");
    });

    it("returns error for invalid YAML", () => {
      const content = `---
name: [invalid yaml
description: broken
---

# Content`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to parse YAML");
    });

    it("returns error for non-string name", () => {
      const content = `---
name: 123
description: A skill
---`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      expect(result.error).toContain("'name' must be a string");
    });

    it("returns error for non-string description", () => {
      const content = `---
name: my-skill
description:
  - list item
---`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      expect(result.error).toContain("'description' must be a string");
    });

    it("returns warning for invalid name format", () => {
      const content = `---
name: My-Invalid-Name
description: A skill with bad name format
---`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(true);
      expect(result.metadata?.name).toBe("My-Invalid-Name");
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("Invalid name format");
    });

    it("returns warning for description exceeding 1024 chars", () => {
      const longDescription = "x".repeat(1025);
      const content = `---
name: my-skill
description: ${longDescription}
---`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("exceeds 1024 characters");
    });

    it("handles Windows line endings (CRLF)", () => {
      const content = "---\r\nname: my-skill\r\ndescription: A skill\r\n---\r\n\r\n# Content";

      const result = parseFrontmatter(content);

      expect(result.success).toBe(true);
      expect(result.metadata?.name).toBe("my-skill");
    });

    it("returns error for empty frontmatter", () => {
      const content = `---
---

# Content`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(false);
      // null parsed from empty YAML
      expect(result.error).toContain("No frontmatter found");
    });

    it("handles multiline description", () => {
      const content = `---
name: my-skill
description: |
  This is a multiline description.
  It spans multiple lines.
---`;

      const result = parseFrontmatter(content);

      expect(result.success).toBe(true);
      expect(result.metadata?.description).toContain("multiline description");
      expect(result.metadata?.description).toContain("multiple lines");
    });
  });

  describe("parseSkillFile", () => {
    it("parses valid SKILL.md file", async () => {
      const skillPath = path.join(tempDir, "SKILL.md");
      await fs.writeFile(
        skillPath,
        `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

Instructions here.`,
      );

      const result = await parseSkillFile(skillPath);

      expect(result.success).toBe(true);
      expect(result.metadata?.name).toBe("test-skill");
      expect(result.metadata?.description).toBe("A test skill for unit testing");
    });

    it("returns error for non-existent file", async () => {
      const skillPath = path.join(tempDir, "nonexistent", "SKILL.md");

      const result = await parseSkillFile(skillPath);

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
    });

    it("returns error for empty file", async () => {
      const skillPath = path.join(tempDir, "SKILL.md");
      await fs.writeFile(skillPath, "");

      const result = await parseSkillFile(skillPath);

      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("returns error for whitespace-only file", async () => {
      const skillPath = path.join(tempDir, "SKILL.md");
      await fs.writeFile(skillPath, "   \n\n   \t  ");

      const result = await parseSkillFile(skillPath);

      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("propagates frontmatter parsing errors", async () => {
      const skillPath = path.join(tempDir, "SKILL.md");
      await fs.writeFile(
        skillPath,
        `---
name: my-skill
---

Missing description field.`,
      );

      const result = await parseSkillFile(skillPath);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required field: description");
    });

    it("propagates warnings from frontmatter parsing", async () => {
      const skillPath = path.join(tempDir, "SKILL.md");
      await fs.writeFile(
        skillPath,
        `---
name: INVALID-NAME
description: Valid description
---

# Content`,
      );

      const result = await parseSkillFile(skillPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("Invalid name format");
    });
  });
});
