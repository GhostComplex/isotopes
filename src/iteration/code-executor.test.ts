// src/iteration/code-executor.test.ts — Tests for CodeExecutor backup/rollback/verify flow
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentBackend } from "../subagent/backend.js";
import type { SubagentEvent } from "../subagent/types.js";
import { CodeExecutor, createBackup, restoreFromBackup } from "./code-executor.js";

function mockBackend(opts: { fail?: boolean; modify?: (target: string) => void; target?: string } = {}): SubagentBackend {
  async function* gen(): AsyncGenerator<SubagentEvent> {
    yield { type: "start" };
    if (opts.modify && opts.target) opts.modify(opts.target);
    if (opts.fail) {
      yield { type: "error", error: "subagent boom" };
      yield { type: "done", exitCode: 1 };
    } else {
      yield { type: "message", content: "ok" };
      yield { type: "done", exitCode: 0 };
    }
  }
  return { spawn: vi.fn(() => gen()) } as unknown as SubagentBackend;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "code-exec-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("createBackup / restoreFromBackup", () => {
  it("creates backup and restores original content", () => {
    const file = join(tmpRoot, "x.ts");
    writeFileSync(file, "original");
    const bak = createBackup(file);
    expect(bak).toBe(`${file}.bak`);
    expect(existsSync(bak!)).toBe(true);
    writeFileSync(file, "modified");

    restoreFromBackup(bak!);
    expect(readFileSync(file, "utf-8")).toBe("original");
    expect(existsSync(bak!)).toBe(false);
  });

  it("returns undefined backup for missing file", () => {
    expect(createBackup(join(tmpRoot, "nope.ts"))).toBeUndefined();
  });

  it("restoreFromBackup returns false when backup missing", () => {
    expect(restoreFromBackup(join(tmpRoot, "nope.bak"))).toBe(false);
  });
});

describe("CodeExecutor.executeModify", () => {
  it("fails when target does not exist", async () => {
    const exec = new CodeExecutor({
      projectRoot: tmpRoot,
      subagent: mockBackend(),
      verify: false,
    });
    const res = await exec.executeModify({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "modify",
      target: "missing.ts",
      description: "x",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("does not exist");
  });

  it("rolls back on subagent failure", async () => {
    const target = join(tmpRoot, "a.ts");
    writeFileSync(target, "original");

    const backend = mockBackend({
      fail: true,
      target,
      modify: (t) => writeFileSync(t, "corrupt"),
    });
    const exec = new CodeExecutor({ projectRoot: tmpRoot, subagent: backend, verify: false });
    const res = await exec.executeModify({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "modify",
      target: "a.ts",
      description: "x",
    });
    expect(res.success).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("original");
    expect(existsSync(`${target}.bak`)).toBe(false);
  });

  it("succeeds and cleans up backup when verify=false and subagent ok", async () => {
    const target = join(tmpRoot, "a.ts");
    writeFileSync(target, "original");
    const exec = new CodeExecutor({
      projectRoot: tmpRoot,
      subagent: mockBackend(),
      verify: false,
    });
    const res = await exec.executeModify({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "modify",
      target: "a.ts",
      description: "x",
    });
    expect(res.success).toBe(true);
    expect(existsSync(`${target}.bak`)).toBe(false);
  });
});

describe("CodeExecutor.executeCreate", () => {
  it("fails when target already exists", async () => {
    const target = join(tmpRoot, "new.ts");
    writeFileSync(target, "exists");
    const exec = new CodeExecutor({
      projectRoot: tmpRoot,
      subagent: mockBackend(),
      verify: false,
    });
    const res = await exec.executeCreate({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "create",
      target: "new.ts",
      description: "x",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("already exists");
  });

  it("fails when subagent completes but file not created", async () => {
    const exec = new CodeExecutor({
      projectRoot: tmpRoot,
      subagent: mockBackend(),
      verify: false,
    });
    const res = await exec.executeCreate({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "create",
      target: "new.ts",
      description: "x",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("not created");
  });

  it("succeeds when subagent creates the file", async () => {
    const target = join(tmpRoot, "new.ts");
    const backend = mockBackend({
      target,
      modify: (t) => writeFileSync(t, "content"),
    });
    const exec = new CodeExecutor({ projectRoot: tmpRoot, subagent: backend, verify: false });
    const res = await exec.executeCreate({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "create",
      target: "new.ts",
      description: "x",
    });
    expect(res.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe("CodeExecutor.executeDelete", () => {
  it("fails when target does not exist", async () => {
    const exec = new CodeExecutor({
      projectRoot: tmpRoot,
      subagent: mockBackend(),
      verify: false,
    });
    const res = await exec.executeDelete({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "delete",
      target: "gone.ts",
      description: "x",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("does not exist");
  });

  it("deletes file and succeeds when verify off", async () => {
    const target = join(tmpRoot, "gone.ts");
    writeFileSync(target, "x");
    const exec = new CodeExecutor({
      projectRoot: tmpRoot,
      subagent: mockBackend(),
      verify: false,
    });
    const res = await exec.executeDelete({
      id: "s1", name: "s1", dependencies: [], status: "pending",
      action: "delete",
      target: "gone.ts",
      description: "x",
    });
    expect(res.success).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});
