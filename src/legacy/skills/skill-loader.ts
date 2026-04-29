// src/skills/skill-loader.ts — Unified skill loading and caching
// Combines discovery, parsing, and prompt generation into a single class.

import { DiscoveryOptions, discoverSkills } from "./discovery.js";
import { parseSkillFile } from "./parser.js";
import { LoadedSkill, generateSkillsPrompt, PromptGeneratorOptions } from "./prompt.js";

export interface SkillLoaderOptions extends DiscoveryOptions {
  /** Log warnings to console. Default: true */
  logWarnings?: boolean;
}

export interface LoadResult {
  skills: LoadedSkill[];
  errors: Array<{ path: string; error: string }>;
  warnings: Array<{ path: string; warning: string }>;
}

export class SkillLoader {
  private options: SkillLoaderOptions;
  private cachedResult: LoadResult | null = null;

  constructor(options?: SkillLoaderOptions) {
    this.options = options ?? {};
  }

  /**
   * Discover and load all skills.
   * Caches result for subsequent calls.
   */
  async load(): Promise<LoadResult> {
    if (this.cachedResult) {
      return this.cachedResult;
    }

    const { logWarnings = true, ...discoveryOptions } = this.options;

    const skills: LoadedSkill[] = [];
    const errors: Array<{ path: string; error: string }> = [];
    const warnings: Array<{ path: string; warning: string }> = [];

    // Discover skill files
    const discovered = await discoverSkills(discoveryOptions);

    // Parse each discovered skill
    for (const { skillPath, directory } of discovered) {
      const result = await parseSkillFile(skillPath);

      if (!result.success) {
        errors.push({
          path: skillPath,
          error: result.error ?? "Unknown parse error",
        });
        continue;
      }

      // Collect warnings
      if (result.warnings) {
        for (const warning of result.warnings) {
          warnings.push({ path: skillPath, warning });
          if (logWarnings) {
            console.warn(`[skills] ${skillPath}: ${warning}`);
          }
        }
      }

      // Add successfully parsed skill
      if (result.metadata) {
        skills.push({
          name: result.metadata.name,
          description: result.metadata.description,
          raw: result.metadata.raw,
          location: skillPath,
          directory,
        });
      }
    }

    this.cachedResult = { skills, errors, warnings };
    return this.cachedResult;
  }

  /**
   * Clear cached skills.
   * Next call to load() or getSkills() will re-scan.
   */
  clearCache(): void {
    this.cachedResult = null;
  }

  /**
   * Get cached skills or load if not cached.
   * Returns only successfully loaded skills.
   */
  async getSkills(): Promise<LoadedSkill[]> {
    const result = await this.load();
    return result.skills;
  }

  /**
   * Generate system prompt block for loaded skills.
   * Loads skills if not already cached.
   */
  async generatePrompt(options?: PromptGeneratorOptions): Promise<string> {
    const skills = await this.getSkills();
    return generateSkillsPrompt(skills, options);
  }
}
