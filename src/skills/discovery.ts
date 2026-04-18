// src/skills/discovery.ts — Skill discovery module
// Scans directories to find SKILL.md files for the skills system.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getIsotopesHome } from "../core/paths.js";

// Directories to skip during recursive scanning
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".cache",
  "dist",
  "build",
  ".next",
  ".nuxt",
]);

const SKILL_FILE = "SKILL.md";

export interface DiscoveryOptions {
  /** Global skills path (default: ~/.isotopes/skills) */
  globalPath?: string;
  /** Workspace path to scan for skills in {workspace}/skills/ */
  workspacePath?: string;
  /** Additional paths to scan for skills */
  additionalPaths?: string[];
  /** Bundled skills path (lowest priority, from package root) */
  bundledPath?: string;
}

export interface DiscoveredSkill {
  /** Absolute path to the SKILL.md file */
  skillPath: string;
  /** Absolute path to the skill directory */
  directory: string;
}

/**
 * Get the default global skills directory.
 */
export function getGlobalSkillsPath(): string {
  return path.join(getIsotopesHome(), "skills");
}

/**
 * Get the workspace skills directory for a given workspace.
 */
export function getWorkspaceSkillsPath(workspacePath: string): string {
  return path.join(workspacePath, "skills");
}

/**
 * Discover skills from configured paths.
 * Scans directories recursively for SKILL.md files.
 *
 * Discovery order (per PRD):
 * 1. Global: ~/.isotopes/skills/
 * 2. Workspace: {workspace}/skills/
 * 3. Additional paths (if provided)
 */
export async function discoverSkills(
  options: DiscoveryOptions = {},
): Promise<DiscoveredSkill[]> {
  const {
    globalPath = getGlobalSkillsPath(),
    workspacePath,
    additionalPaths = [],
    bundledPath,
  } = options;

  const pathsToScan: string[] = [];

  // Add paths in discovery order (bundled first = lowest priority, last wins on dedup)
  if (bundledPath) {
    pathsToScan.push(bundledPath);
  }

  pathsToScan.push(globalPath);

  if (workspacePath) {
    pathsToScan.push(getWorkspaceSkillsPath(workspacePath));
  }

  pathsToScan.push(...additionalPaths);

  // Scan all paths and collect skills
  const allSkills: DiscoveredSkill[] = [];
  const seenDirectories = new Set<string>();

  for (const scanPath of pathsToScan) {
    const skills = await scanDirectory(scanPath);
    for (const skill of skills) {
      // Deduplicate by directory path
      if (!seenDirectories.has(skill.directory)) {
        seenDirectories.add(skill.directory);
        allSkills.push(skill);
      }
    }
  }

  return allSkills;
}

interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * Recursively scan a directory for SKILL.md files.
 * Returns empty array if directory doesn't exist.
 */
async function scanDirectory(dirPath: string): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [];

  // Check if directory exists
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      return skills;
    }
  } catch {
    // Directory doesn't exist, silently skip
    return skills;
  }

  // Read directory contents
  let entries: DirEntry[];
  try {
    entries = (await fs.readdir(dirPath, { withFileTypes: true })) as DirEntry[];
  } catch {
    return skills;
  }

  // Check if this directory contains SKILL.md
  const hasSkillFile = entries.some(
    (entry) => entry.isFile() && entry.name === SKILL_FILE,
  );

  if (hasSkillFile) {
    skills.push({
      skillPath: path.join(dirPath, SKILL_FILE),
      directory: dirPath,
    });
  }

  // Recursively scan subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    // Skip ignored directories
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const subDirPath = path.join(dirPath, entry.name);
    const subSkills = await scanDirectory(subDirPath);
    skills.push(...subSkills);
  }

  return skills;
}

/**
 * Expand ~ to home directory in a path.
 */
export function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
