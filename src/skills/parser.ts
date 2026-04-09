// src/skills/parser.ts — SKILL.md frontmatter parser and validator
// Parses YAML frontmatter from skill files and validates required fields.

import fs from "node:fs/promises";
import YAML from "yaml";

export interface SkillMetadata {
  name: string;
  description: string;
  /** Preserve original frontmatter for future extensions */
  raw?: Record<string, unknown>;
}

export interface ParseResult {
  success: boolean;
  metadata?: SkillMetadata;
  error?: string;
  warnings?: string[];
}

// Regex to extract YAML frontmatter between --- delimiters
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

// Name validation: lowercase a-z, 0-9, hyphens, 1-64 chars
// No leading/trailing hyphens, no consecutive hyphens
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Validate a skill name according to the spec.
 * Returns validation result with optional message.
 */
export function validateSkillName(name: string): {
  valid: boolean;
  message?: string;
} {
  if (typeof name !== "string") {
    return { valid: false, message: "Name must be a string" };
  }

  if (name.length < NAME_MIN_LENGTH) {
    return { valid: false, message: "Name cannot be empty" };
  }

  if (name.length > NAME_MAX_LENGTH) {
    return {
      valid: false,
      message: `Name exceeds ${NAME_MAX_LENGTH} characters`,
    };
  }

  if (!NAME_PATTERN.test(name)) {
    return {
      valid: false,
      message:
        "Name must be lowercase letters, numbers, and hyphens only. No leading/trailing hyphens or consecutive hyphens.",
    };
  }

  return { valid: true };
}

/**
 * Parse frontmatter from SKILL.md content.
 * Extracts YAML between --- delimiters and validates required fields.
 */
export function parseFrontmatter(content: string): ParseResult {
  const warnings: string[] = [];

  // Check for frontmatter
  const match = FRONTMATTER_REGEX.exec(content);
  if (!match) {
    return {
      success: false,
      error: "No frontmatter found. SKILL.md must start with --- delimited YAML.",
    };
  }

  const yamlContent = match[1];

  // Parse YAML
  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(yamlContent) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to parse YAML frontmatter: ${message}`,
    };
  }

  // Handle empty or non-object frontmatter
  if (!parsed || typeof parsed !== "object") {
    return {
      success: false,
      error: "Frontmatter must be a YAML object",
    };
  }

  // Validate required fields
  const { name, description } = parsed;

  // Check name
  if (name === undefined || name === null) {
    return {
      success: false,
      error: "Missing required field: name",
    };
  }

  if (typeof name !== "string") {
    return {
      success: false,
      error: "Field 'name' must be a string",
    };
  }

  // Validate name format (warnings, not errors per PRD)
  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid && nameValidation.message) {
    warnings.push(`Invalid name format: ${nameValidation.message}`);
  }

  // Check description
  if (description === undefined || description === null) {
    return {
      success: false,
      error: "Missing required field: description",
    };
  }

  if (typeof description !== "string") {
    return {
      success: false,
      error: "Field 'description' must be a string",
    };
  }

  // Validate description length (warning, not error)
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    warnings.push(
      `Description exceeds ${DESCRIPTION_MAX_LENGTH} characters (${description.length} chars)`,
    );
  }

  const result: ParseResult = {
    success: true,
    metadata: {
      name: String(name),
      description: String(description),
      raw: parsed,
    },
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

/**
 * Read and parse a SKILL.md file.
 * Returns parsed metadata or error information.
 */
export async function parseSkillFile(skillPath: string): Promise<ParseResult> {
  // Read file
  let content: string;
  try {
    content = await fs.readFile(skillPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        success: false,
        error: `File not found: ${skillPath}`,
      };
    }
    if (code === "EACCES") {
      return {
        success: false,
        error: `Permission denied: ${skillPath}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to read file: ${message}`,
    };
  }

  // Handle empty file
  if (!content.trim()) {
    return {
      success: false,
      error: "File is empty",
    };
  }

  return parseFrontmatter(content);
}
