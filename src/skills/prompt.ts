// src/skills/prompt.ts — Generate skills system prompt block
// Produces XML-formatted skill descriptions for agent system prompts.

import type { SkillMetadata } from "./parser.js";

export interface LoadedSkill extends SkillMetadata {
  /** Absolute path to SKILL.md */
  location: string;
  /** Skill directory for relative path resolution */
  directory: string;
}

export interface PromptGeneratorOptions {
  /** Output format. Default: "xml" */
  format?: "xml" | "markdown" | "json";
  /** Include instruction block before skills. Default: true */
  includeInstructions?: boolean;
}

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate the instruction block that precedes skills.
 */
export function generateInstructions(): string {
  return `## Skills

Before replying, scan <available_skills> descriptions.
- If exactly one skill clearly applies: read its SKILL.md at <location>, then follow it.
- If multiple could apply: choose the most specific one, then read/follow.
- If none apply: proceed without loading any skill.

When a skill references relative paths, resolve them against the skill directory.`;
}

/**
 * Generate XML block containing skill information.
 */
export function generateXmlBlock(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const skillEntries = skills
    .map(
      (skill) => `  <skill>
    <name>${escapeXml(skill.name)}</name>
    <description>${escapeXml(skill.description)}</description>
    <location>${escapeXml(skill.location)}</location>
  </skill>`,
    )
    .join("\n");

  return `<available_skills>
${skillEntries}
</available_skills>`;
}

/**
 * Generate complete skills prompt block.
 * Returns empty string if no skills are provided.
 */
export function generateSkillsPrompt(
  skills: LoadedSkill[],
  options?: PromptGeneratorOptions,
): string {
  const { format = "xml", includeInstructions = true } = options ?? {};

  if (skills.length === 0) {
    return "";
  }

  const parts: string[] = [];

  if (includeInstructions) {
    parts.push(generateInstructions());
  }

  switch (format) {
    case "xml":
      parts.push(generateXmlBlock(skills));
      break;
    case "markdown":
      parts.push(generateMarkdownBlock(skills));
      break;
    case "json":
      parts.push(generateJsonBlock(skills));
      break;
  }

  return parts.join("\n\n");
}

/**
 * Generate markdown-formatted skill list.
 */
function generateMarkdownBlock(skills: LoadedSkill[]): string {
  const entries = skills
    .map(
      (skill) =>
        `### ${skill.name}\n\n${skill.description}\n\n**Location:** \`${skill.location}\``,
    )
    .join("\n\n");

  return `## Available Skills\n\n${entries}`;
}

/**
 * Generate JSON-formatted skill list.
 */
function generateJsonBlock(skills: LoadedSkill[]): string {
  const data = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: skill.location,
  }));

  return JSON.stringify({ available_skills: data }, null, 2);
}
