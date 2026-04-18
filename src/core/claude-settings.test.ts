// src/core/claude-settings.test.ts — Tests for loadClaudeSettingsEnv
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClaudeSettingsEnv } from "./claude-settings.js";

const KEYS = ["ISOTOPES_TEST_X", "ISOTOPES_TEST_Y", "ISOTOPES_TEST_Z"];

describe("loadClaudeSettingsEnv", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-settings-"));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of KEYS) delete process.env[k];
  });

  it("loads string env values into process.env", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(path, JSON.stringify({ env: { ISOTOPES_TEST_X: "hello" } }));
    loadClaudeSettingsEnv(path);
    expect(process.env.ISOTOPES_TEST_X).toBe("hello");
  });

  it("does not overwrite existing process.env values", () => {
    process.env.ISOTOPES_TEST_X = "original";
    const path = join(tmpDir, "settings.json");
    writeFileSync(path, JSON.stringify({ env: { ISOTOPES_TEST_X: "from-file" } }));
    loadClaudeSettingsEnv(path);
    expect(process.env.ISOTOPES_TEST_X).toBe("original");
  });

  it("skips missing files silently", () => {
    expect(() => loadClaudeSettingsEnv(join(tmpDir, "nope.json"))).not.toThrow();
  });

  it("skips malformed JSON without throwing", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(path, "{ not valid json");
    expect(() => loadClaudeSettingsEnv(path)).not.toThrow();
    expect(process.env.ISOTOPES_TEST_X).toBeUndefined();
  });

  it("ignores files without an env block", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: {} }));
    expect(() => loadClaudeSettingsEnv(path)).not.toThrow();
  });

  it("skips non-string values", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ env: { ISOTOPES_TEST_X: 42, ISOTOPES_TEST_Y: "ok", ISOTOPES_TEST_Z: null } }),
    );
    loadClaudeSettingsEnv(path);
    expect(process.env.ISOTOPES_TEST_X).toBeUndefined();
    expect(process.env.ISOTOPES_TEST_Y).toBe("ok");
    expect(process.env.ISOTOPES_TEST_Z).toBeUndefined();
  });

  it("respects CLAUDE_SETTINGS_PATH env override", () => {
    const path = join(tmpDir, "alt.json");
    writeFileSync(path, JSON.stringify({ env: { ISOTOPES_TEST_X: "from-override" } }));
    process.env.CLAUDE_SETTINGS_PATH = path;
    try {
      loadClaudeSettingsEnv();
      expect(process.env.ISOTOPES_TEST_X).toBe("from-override");
    } finally {
      delete process.env.CLAUDE_SETTINGS_PATH;
    }
  });
});
