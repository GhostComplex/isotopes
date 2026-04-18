// src/skills/bundled-dir.test.ts — Tests for bundled skills directory resolution

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  looksLikeSkillsDir,
  resolveBundledSkillsDir,
  clearBundledSkillsCache,
} from "./bundled-dir.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bundled-dir-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("looksLikeSkillsDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("returns false for empty directory", () => {
    expect(looksLikeSkillsDir(tmpDir)).toBe(false);
  });

  it("returns false for non-existent directory", () => {
    expect(looksLikeSkillsDir("/tmp/does-not-exist-xyz")).toBe(false);
  });

  it("returns false for directory with only files", () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "hello");
    expect(looksLikeSkillsDir(tmpDir)).toBe(false);
  });

  it("returns false for subdirectory without SKILL.md", () => {
    fs.mkdirSync(path.join(tmpDir, "my-skill"));
    fs.writeFileSync(path.join(tmpDir, "my-skill", "README.md"), "no skill");
    expect(looksLikeSkillsDir(tmpDir)).toBe(false);
  });

  it("returns true for subdirectory with SKILL.md", () => {
    fs.mkdirSync(path.join(tmpDir, "github"));
    fs.writeFileSync(path.join(tmpDir, "github", "SKILL.md"), "---\nname: github\n---");
    expect(looksLikeSkillsDir(tmpDir)).toBe(true);
  });

  it("ignores dot-prefixed directories", () => {
    fs.mkdirSync(path.join(tmpDir, ".hidden"));
    fs.writeFileSync(path.join(tmpDir, ".hidden", "SKILL.md"), "---\nname: hidden\n---");
    expect(looksLikeSkillsDir(tmpDir)).toBe(false);
  });
});

describe("resolveBundledSkillsDir", () => {
  const origEnv = process.env.ISOTOPES_BUNDLED_SKILLS_DIR;

  beforeEach(() => {
    clearBundledSkillsCache();
    delete process.env.ISOTOPES_BUNDLED_SKILLS_DIR;
  });

  afterEach(() => {
    clearBundledSkillsCache();
    if (origEnv !== undefined) {
      process.env.ISOTOPES_BUNDLED_SKILLS_DIR = origEnv;
    } else {
      delete process.env.ISOTOPES_BUNDLED_SKILLS_DIR;
    }
  });

  it("returns a string when running from the isotopes repo", () => {
    // This test runs inside the isotopes repo which has skills/ at root
    const result = resolveBundledSkillsDir();
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result!.endsWith("/skills")).toBe(true);
  });

  it("caches the result on subsequent calls", () => {
    const first = resolveBundledSkillsDir();
    const second = resolveBundledSkillsDir();
    expect(first).toBe(second);
  });

  it("uses env override when valid", () => {
    const tmpDir = makeTempDir();
    const skillDir = path.join(tmpDir, "my-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: test\n---");

    process.env.ISOTOPES_BUNDLED_SKILLS_DIR = tmpDir;
    const result = resolveBundledSkillsDir();
    expect(result).toBe(tmpDir);

    cleanup(tmpDir);
  });

  it("ignores env override when path does not exist", () => {
    process.env.ISOTOPES_BUNDLED_SKILLS_DIR = "/tmp/nonexistent-skills-xyz";
    const result = resolveBundledSkillsDir();
    // Should fall back to auto-detect (which finds the repo's skills/)
    expect(result).not.toBe("/tmp/nonexistent-skills-xyz");
  });

  it("ignores env override when path is not a valid skills dir", () => {
    const tmpDir = makeTempDir();
    process.env.ISOTOPES_BUNDLED_SKILLS_DIR = tmpDir;
    const result = resolveBundledSkillsDir();
    expect(result).not.toBe(tmpDir);
    cleanup(tmpDir);
  });

  it("clearBundledSkillsCache resets cache", () => {
    resolveBundledSkillsDir(); // populate cache
    clearBundledSkillsCache();
    // After clearing, it should recompute (same result but not cached)
    const result = resolveBundledSkillsDir();
    expect(result).toBeDefined();
  });
});
