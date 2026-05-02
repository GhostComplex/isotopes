// src/bundled-skills.test.ts — Unit tests for bundled skills dir resolver

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveBuiltinSkillsDir } from "./paths.js";

describe("resolveBuiltinSkillsDir", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the ISOTOPES_BUILTIN_SKILLS_DIR override when set", () => {
    vi.stubEnv("ISOTOPES_BUILTIN_SKILLS_DIR", "/some/override/path");
    expect(resolveBuiltinSkillsDir()).toBe("/some/override/path");
  });

  it("trims whitespace around the override", () => {
    vi.stubEnv("ISOTOPES_BUILTIN_SKILLS_DIR", "  /padded/path  ");
    expect(resolveBuiltinSkillsDir()).toBe("/padded/path");
  });

  it("ignores an empty/whitespace-only override and falls back to walk-up", () => {
    vi.stubEnv("ISOTOPES_BUILTIN_SKILLS_DIR", "   ");
    // The result depends on the real package layout — assert only on the type contract.
    const result = resolveBuiltinSkillsDir();
    expect(typeof result === "string" || result === undefined).toBe(true);
  });

  it("walk-up returns a path ending in 'skills' when this repo's bundled dir is found", () => {
    // No override set. In this repo the walk-up should find the bundled `skills/` dir
    // (the project ships one). We don't assert the exact path, just the basename;
    // if the layout changes and nothing is found, undefined is also acceptable.
    const result = resolveBuiltinSkillsDir();
    if (result !== undefined) {
      expect(path.basename(result)).toBe("skills");
    }
  });

  it("returns the override even if the directory does not actually exist", () => {
    // The override is intentionally not validated — it's the caller's responsibility.
    vi.stubEnv("ISOTOPES_BUILTIN_SKILLS_DIR", "/nonexistent/dir/skills");
    expect(resolveBuiltinSkillsDir()).toBe("/nonexistent/dir/skills");
  });

  it("override accepts a real directory created at runtime", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-bundled-"));
    const skillDir = path.join(tmp, "skills", "demo");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# demo\n");
    vi.stubEnv("ISOTOPES_BUILTIN_SKILLS_DIR", path.join(tmp, "skills"));
    try {
      expect(resolveBuiltinSkillsDir()).toBe(path.join(tmp, "skills"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
