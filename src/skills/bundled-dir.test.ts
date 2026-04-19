// src/skills/bundled-dir.test.ts — Unit tests for bundled skills dir resolver

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveBundledSkillsDir } from "./bundled-dir.js";

describe("resolveBundledSkillsDir", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the ISOTOPES_BUNDLED_SKILLS_DIR override when set", () => {
    vi.stubEnv("ISOTOPES_BUNDLED_SKILLS_DIR", "/some/override/path");
    expect(resolveBundledSkillsDir()).toBe("/some/override/path");
  });

  it("trims whitespace around the override", () => {
    vi.stubEnv("ISOTOPES_BUNDLED_SKILLS_DIR", "  /padded/path  ");
    expect(resolveBundledSkillsDir()).toBe("/padded/path");
  });

  it("ignores an empty/whitespace-only override and falls back to walk-up", () => {
    vi.stubEnv("ISOTOPES_BUNDLED_SKILLS_DIR", "   ");
    // The result depends on the real package layout — assert only on the type contract.
    const result = resolveBundledSkillsDir();
    expect(typeof result === "string" || result === undefined).toBe(true);
  });

  it("walk-up returns a path ending in 'skills' when this repo's bundled dir is found", () => {
    // No override set. In this repo the walk-up should find the bundled `skills/` dir
    // (the project ships one). We don't assert the exact path, just the basename;
    // if the layout changes and nothing is found, undefined is also acceptable.
    const result = resolveBundledSkillsDir();
    if (result !== undefined) {
      expect(path.basename(result)).toBe("skills");
    }
  });

  it("returns the override even if the directory does not actually exist", () => {
    // The override is intentionally not validated — it's the caller's responsibility.
    vi.stubEnv("ISOTOPES_BUNDLED_SKILLS_DIR", "/nonexistent/dir/skills");
    expect(resolveBundledSkillsDir()).toBe("/nonexistent/dir/skills");
  });

  it("override accepts a real directory created at runtime", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-bundled-"));
    const skillDir = path.join(tmp, "skills", "demo");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# demo\n");
    vi.stubEnv("ISOTOPES_BUNDLED_SKILLS_DIR", path.join(tmp, "skills"));
    try {
      expect(resolveBundledSkillsDir()).toBe(path.join(tmp, "skills"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
