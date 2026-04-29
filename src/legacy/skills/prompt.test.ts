// src/skills/prompt.test.ts — Unit tests for skill prompt generation

import { describe, it, expect } from "vitest";
import {
  generateSkillsPrompt,
  generateXmlBlock,
  generateInstructions,
  type LoadedSkill,
} from "./prompt.js";

describe("Skill Prompt Generator", () => {
  const sampleSkill: LoadedSkill = {
    name: "web-search",
    description: "Search the web using DuckDuckGo.",
    location: "~/.isotopes/skills/web-search/SKILL.md",
    directory: "~/.isotopes/skills/web-search",
  };

  const anotherSkill: LoadedSkill = {
    name: "github-issues",
    description: "Create, list, and manage GitHub issues.",
    location: "/home/user/workspace/skills/github-issues/SKILL.md",
    directory: "/home/user/workspace/skills/github-issues",
  };

  describe("generateXmlBlock", () => {
    it("generates XML for a single skill", () => {
      const result = generateXmlBlock([sampleSkill]);

      expect(result).toContain("<available_skills>");
      expect(result).toContain("</available_skills>");
      expect(result).toContain("<name>web-search</name>");
      expect(result).toContain(
        "<description>Search the web using DuckDuckGo.</description>",
      );
      expect(result).toContain(
        "<location>~/.isotopes/skills/web-search/SKILL.md</location>",
      );
    });

    it("generates XML for multiple skills", () => {
      const result = generateXmlBlock([sampleSkill, anotherSkill]);

      expect(result).toContain("<name>web-search</name>");
      expect(result).toContain("<name>github-issues</name>");
      expect(result).toContain(
        "<description>Create, list, and manage GitHub issues.</description>",
      );
    });

    it("returns empty string for empty skills array", () => {
      const result = generateXmlBlock([]);
      expect(result).toBe("");
    });

    it("escapes XML special characters in name", () => {
      const skill: LoadedSkill = {
        name: "test<>&skill",
        description: "A normal description",
        location: "/path/to/SKILL.md",
        directory: "/path/to",
      };

      const result = generateXmlBlock([skill]);

      expect(result).toContain("<name>test&lt;&gt;&amp;skill</name>");
      expect(result).not.toContain("<name>test<>&skill</name>");
    });

    it("escapes XML special characters in description", () => {
      const skill: LoadedSkill = {
        name: "test-skill",
        description: 'Use <code> & "quotes" for \'emphasis\'',
        location: "/path/to/SKILL.md",
        directory: "/path/to",
      };

      const result = generateXmlBlock([skill]);

      expect(result).toContain(
        "<description>Use &lt;code&gt; &amp; &quot;quotes&quot; for &apos;emphasis&apos;</description>",
      );
    });

    it("escapes XML special characters in location", () => {
      const skill: LoadedSkill = {
        name: "test-skill",
        description: "Test",
        location: "/path/with<special>&chars/SKILL.md",
        directory: "/path/with<special>&chars",
      };

      const result = generateXmlBlock([skill]);

      expect(result).toContain(
        "<location>/path/with&lt;special&gt;&amp;chars/SKILL.md</location>",
      );
    });

    it("formats XML with proper indentation", () => {
      const result = generateXmlBlock([sampleSkill]);

      // Check structure
      const lines = result.split("\n");
      expect(lines[0]).toBe("<available_skills>");
      expect(lines[1]).toBe("  <skill>");
      expect(lines[2]).toMatch(/^\s{4}<name>/);
      expect(lines[lines.length - 1]).toBe("</available_skills>");
    });
  });

  describe("generateInstructions", () => {
    it("returns the instruction block", () => {
      const result = generateInstructions();

      expect(result).toContain("## Skills");
      expect(result).toContain("scan <available_skills> descriptions");
      expect(result).toContain("read its SKILL.md at <location>");
      expect(result).toContain("resolve them against the skill directory");
    });

    it("contains all three decision rules", () => {
      const result = generateInstructions();

      expect(result).toContain("exactly one skill clearly applies");
      expect(result).toContain("multiple could apply");
      expect(result).toContain("none apply");
    });
  });

  describe("generateSkillsPrompt", () => {
    it("returns empty string for empty skills array", () => {
      const result = generateSkillsPrompt([]);
      expect(result).toBe("");
    });

    it("returns empty string for empty array even with includeInstructions true", () => {
      const result = generateSkillsPrompt([], { includeInstructions: true });
      expect(result).toBe("");
    });

    it("includes instructions by default", () => {
      const result = generateSkillsPrompt([sampleSkill]);

      expect(result).toContain("## Skills");
      expect(result).toContain("<available_skills>");
    });

    it("excludes instructions when includeInstructions is false", () => {
      const result = generateSkillsPrompt([sampleSkill], {
        includeInstructions: false,
      });

      expect(result).not.toContain("## Skills");
      expect(result).toContain("<available_skills>");
    });

    it("uses XML format by default", () => {
      const result = generateSkillsPrompt([sampleSkill]);

      expect(result).toContain("<available_skills>");
      expect(result).toContain("<skill>");
    });

    it("supports markdown format", () => {
      const result = generateSkillsPrompt([sampleSkill], { format: "markdown" });

      expect(result).toContain("## Available Skills");
      expect(result).toContain("### web-search");
      expect(result).toContain("**Location:**");
      expect(result).not.toMatch(/<available_skills>\n {2}<skill>/);
    });

    it("supports JSON format", () => {
      const result = generateSkillsPrompt([sampleSkill], { format: "json" });

      expect(result).toContain('"available_skills"');
      expect(result).toContain('"name": "web-search"');
      expect(result).not.toMatch(/<available_skills>\n {2}<skill>/);
    });

    it("separates instructions and skills block with blank line", () => {
      const result = generateSkillsPrompt([sampleSkill]);

      // Instructions end, then blank line, then XML
      expect(result).toMatch(/skill directory\.\n\n<available_skills>/);
    });

    it("handles all special characters in combined output", () => {
      const specialSkill: LoadedSkill = {
        name: "special-skill",
        description: 'Handles <tags>, &ampersands, "quotes", and \'apostrophes\'',
        location: "/path/to/SKILL.md",
        directory: "/path/to",
      };

      const result = generateSkillsPrompt([specialSkill]);

      expect(result).toContain("&lt;tags&gt;");
      expect(result).toContain("&amp;ampersands");
      expect(result).toContain("&quot;quotes&quot;");
      expect(result).toContain("&apos;apostrophes&apos;");
    });

    it("preserves skill order in output", () => {
      const skills: LoadedSkill[] = [
        { ...sampleSkill, name: "aaa-first" },
        { ...sampleSkill, name: "mmm-middle" },
        { ...sampleSkill, name: "zzz-last" },
      ];

      const result = generateSkillsPrompt(skills);

      const firstIndex = result.indexOf("aaa-first");
      const middleIndex = result.indexOf("mmm-middle");
      const lastIndex = result.indexOf("zzz-last");

      expect(firstIndex).toBeLessThan(middleIndex);
      expect(middleIndex).toBeLessThan(lastIndex);
    });
  });

  describe("markdown format", () => {
    it("generates markdown with proper structure", () => {
      const result = generateSkillsPrompt([sampleSkill, anotherSkill], {
        format: "markdown",
        includeInstructions: false,
      });

      expect(result).toContain("## Available Skills");
      expect(result).toContain("### web-search");
      expect(result).toContain("### github-issues");
      expect(result).toContain(
        "**Location:** `~/.isotopes/skills/web-search/SKILL.md`",
      );
    });
  });

  describe("JSON format", () => {
    it("generates valid JSON", () => {
      const result = generateSkillsPrompt([sampleSkill], {
        format: "json",
        includeInstructions: false,
      });

      const parsed = JSON.parse(result);
      expect(parsed.available_skills).toHaveLength(1);
      expect(parsed.available_skills[0].name).toBe("web-search");
    });

    it("includes all skill fields in JSON", () => {
      const result = generateSkillsPrompt([sampleSkill], {
        format: "json",
        includeInstructions: false,
      });

      const parsed = JSON.parse(result);
      const skill = parsed.available_skills[0];

      expect(skill.name).toBe("web-search");
      expect(skill.description).toBe("Search the web using DuckDuckGo.");
      expect(skill.location).toBe("~/.isotopes/skills/web-search/SKILL.md");
    });
  });
});
