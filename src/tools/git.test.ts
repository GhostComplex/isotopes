// src/tools/git.test.ts — Unit tests for git CLI wrapper

import { describe, it, expect, vi, beforeEach } from "vitest";
import { exec } from "node:child_process";

// Mock child_process.exec before importing the module under test
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// We must also mock node:util so promisify returns our mock
vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

// Now exec IS the mock function (promisify returns it as-is)
const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

// Import after mocking
import {
  status,
  log,
  diff,
  add,
  commit,
  push,
  pull,
  checkout,
  branch,
  revParse,
} from "./git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecResolve(stdout: string, stderr = "") {
  mockExec.mockResolvedValueOnce({ stdout, stderr });
}

function mockExecReject(error: Error) {
  mockExec.mockRejectedValueOnce(error);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git.status", () => {
  it("parses staged, modified, and untracked files", async () => {
    mockExecResolve(
      [
        "M  src/index.ts",      // staged (modified)
        " M src/utils.ts",      // worktree modified
        "A  new-file.ts",       // staged (added)
        "?? untracked.txt",     // untracked
      ].join("\n"),
    );

    const result = await status();

    expect(result.staged).toEqual(["src/index.ts", "new-file.ts"]);
    expect(result.modified).toEqual(["src/utils.ts"]);
    expect(result.untracked).toEqual(["untracked.txt"]);
  });

  it("returns empty arrays for clean repo", async () => {
    mockExecResolve("");

    const result = await status();

    expect(result.staged).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it("passes cwd option to exec", async () => {
    mockExecResolve("");

    await status({ cwd: "/some/repo" });

    expect(mockExec).toHaveBeenCalledWith(
      "git status --porcelain",
      expect.objectContaining({ cwd: "/some/repo" }),
    );
  });
});

describe("git.log", () => {
  it("parses log entries", async () => {
    const sep = "---GIT_LOG_SEP---";
    mockExecResolve(
      [
        `abc123${sep}Alice${sep}2024-01-15T10:00:00Z${sep}Initial commit`,
        `def456${sep}Bob${sep}2024-01-16T11:00:00Z${sep}Add feature`,
      ].join("\n"),
    );

    const entries = await log();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      hash: "abc123",
      author: "Alice",
      date: "2024-01-15T10:00:00Z",
      message: "Initial commit",
    });
    expect(entries[1]).toEqual({
      hash: "def456",
      author: "Bob",
      date: "2024-01-16T11:00:00Z",
      message: "Add feature",
    });
  });

  it("returns empty array for empty log", async () => {
    mockExecResolve("");

    const entries = await log();

    expect(entries).toEqual([]);
  });

  it("respects maxCount option", async () => {
    mockExecResolve("");

    await log({ maxCount: 5 });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--max-count=5"),
      expect.anything(),
    );
  });
});

describe("git.diff", () => {
  it("returns diff output", async () => {
    mockExecResolve("diff --git a/file.ts b/file.ts\n+new line");

    const result = await diff();

    expect(result).toContain("+new line");
  });

  it("passes --cached for staged diff", async () => {
    mockExecResolve("");

    await diff({ staged: true });

    expect(mockExec).toHaveBeenCalledWith(
      "git diff --cached",
      expect.anything(),
    );
  });

  it("passes ref argument", async () => {
    mockExecResolve("");

    await diff({ ref: "main...HEAD" });

    expect(mockExec).toHaveBeenCalledWith(
      "git diff main...HEAD",
      expect.anything(),
    );
  });
});

describe("git.add", () => {
  it("stages specified files", async () => {
    mockExecResolve("");

    await add(["file1.ts", "file2.ts"]);

    expect(mockExec).toHaveBeenCalledWith(
      "git add -- file1.ts file2.ts",
      expect.anything(),
    );
  });

  it("throws if no files given", async () => {
    await expect(add([])).rejects.toThrow("at least one file path");
  });
});

describe("git.commit", () => {
  it("creates commit with message", async () => {
    mockExecResolve("[main abc123] feat: add feature\n 1 file changed");

    const result = await commit("feat: add feature");

    expect(mockExec).toHaveBeenCalledWith(
      "git commit -m feat: add feature",
      expect.anything(),
    );
    expect(result).toContain("abc123");
  });

  it("throws on empty message", async () => {
    await expect(commit("")).rejects.toThrow("must not be empty");
  });
});

describe("git.push", () => {
  it("pushes to origin by default", async () => {
    mockExecResolve("", "Everything up-to-date");

    const result = await push();

    expect(mockExec).toHaveBeenCalledWith(
      "git push origin",
      expect.anything(),
    );
    expect(result).toContain("Everything up-to-date");
  });

  it("supports -u flag and branch", async () => {
    mockExecResolve("", "Branch 'feat' set up to track");

    await push({ setUpstream: true, branch: "feat" });

    expect(mockExec).toHaveBeenCalledWith(
      "git push -u origin feat",
      expect.anything(),
    );
  });
});

describe("git.pull", () => {
  it("pulls from origin by default", async () => {
    mockExecResolve("Already up to date.");

    const result = await pull();

    expect(mockExec).toHaveBeenCalledWith(
      "git pull origin",
      expect.anything(),
    );
    expect(result).toContain("Already up to date");
  });

  it("supports remote and branch", async () => {
    mockExecResolve("Updating abc..def");

    await pull({ remote: "upstream", branch: "main" });

    expect(mockExec).toHaveBeenCalledWith(
      "git pull upstream main",
      expect.anything(),
    );
  });
});

describe("git.checkout", () => {
  it("switches to target branch", async () => {
    mockExecResolve("", "Switched to branch 'main'");

    const result = await checkout("main");

    expect(mockExec).toHaveBeenCalledWith(
      "git checkout main",
      expect.anything(),
    );
    expect(result).toContain("Switched to branch");
  });

  it("creates new branch with -b", async () => {
    mockExecResolve("", "Switched to a new branch 'feat'");

    await checkout("feat", { create: true });

    expect(mockExec).toHaveBeenCalledWith(
      "git checkout -b feat",
      expect.anything(),
    );
  });
});

describe("git.branch", () => {
  it("lists branches by default", async () => {
    mockExecResolve("* main\n  feat/test");

    const result = await branch();

    expect(result).toContain("main");
    expect(result).toContain("feat/test");
    expect(mockExec).toHaveBeenCalledWith(
      "git branch",
      expect.anything(),
    );
  });

  it("creates a new branch", async () => {
    mockExecResolve("");

    await branch({ name: "new-branch" });

    expect(mockExec).toHaveBeenCalledWith(
      "git branch new-branch",
      expect.anything(),
    );
  });

  it("deletes a branch", async () => {
    mockExecResolve("Deleted branch old-branch");

    await branch({ name: "old-branch", delete: true });

    expect(mockExec).toHaveBeenCalledWith(
      "git branch -d old-branch",
      expect.anything(),
    );
  });
});

describe("git.revParse", () => {
  it("resolves HEAD", async () => {
    mockExecResolve("abc123def456");

    const result = await revParse(["HEAD"]);

    expect(result).toBe("abc123def456");
    expect(mockExec).toHaveBeenCalledWith(
      "git rev-parse HEAD",
      expect.anything(),
    );
  });
});

describe("error handling", () => {
  it("propagates exec errors", async () => {
    mockExecReject(new Error("fatal: not a git repository"));

    await expect(status()).rejects.toThrow("not a git repository");
  });
});
