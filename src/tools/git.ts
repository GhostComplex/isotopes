// src/tools/git.ts — Git CLI wrapper for agent tooling
// Provides typed wrappers around common git operations.

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options common to all git commands (working directory, timeout). */
export interface GitOptions {
  /** Working directory for git commands */
  cwd?: string;
  /** Maximum execution time in ms (default: 30_000) */
  timeout?: number;
}

/** Parsed result of `git status --porcelain`. */
export interface GitStatusResult {
  staged: string[];
  modified: string[];
  untracked: string[];
  raw: string;
}

/** A single commit entry from `git log`. */
export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/** Raw stdout/stderr result from a git command. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a git command and return the raw result.
 * Throws on non-zero exit code.
 */
async function gitExec(
  args: string[],
  options: GitOptions = {},
): Promise<GitExecResult> {
  const { cwd, timeout = 30_000 } = options;
  const command = `git ${args.join(" ")}`;

  const { stdout, stderr } = await execAsync(command, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });

  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * `git status --porcelain` parsed into staged / modified / untracked buckets.
 */
export async function status(options: GitOptions = {}): Promise<GitStatusResult> {
  const { stdout } = await gitExec(["status", "--porcelain"], options);

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const x = line[0]; // index status
    const y = line[1]; // worktree status
    const file = line.slice(3);

    if (x === "?" && y === "?") {
      untracked.push(file);
    } else {
      if (x && x !== " " && x !== "?") staged.push(file);
      if (y && y !== " " && y !== "?") modified.push(file);
    }
  }

  return { staged, modified, untracked, raw: stdout };
}

/**
 * `git log` — returns the most recent commits.
 */
export async function log(
  options: GitOptions & { maxCount?: number } = {},
): Promise<GitLogEntry[]> {
  const { maxCount = 10, ...gitOpts } = options;
  const sep = "---GIT_LOG_SEP---";
  const format = `%H${sep}%an${sep}%aI${sep}%s`;

  const { stdout } = await gitExec(
    ["log", `--max-count=${maxCount}`, `--format=${format}`],
    gitOpts,
  );

  if (!stdout) return [];

  return stdout.split("\n").map((line) => {
    const [hash, author, date, message] = line.split(sep);
    return { hash, author, date, message };
  });
}

/**
 * `git diff` — returns the diff output.
 */
export async function diff(
  options: GitOptions & { staged?: boolean; ref?: string } = {},
): Promise<string> {
  const { staged = false, ref, ...gitOpts } = options;
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (ref) args.push(ref);

  const { stdout } = await gitExec(args, gitOpts);
  return stdout;
}

/**
 * `git add` — stage files.
 */
export async function add(
  files: string[],
  options: GitOptions = {},
): Promise<string> {
  if (files.length === 0) {
    throw new Error("Git add requires at least one file path");
  }
  const { stdout } = await gitExec(["add", "--", ...files], options);
  return stdout;
}

/**
 * `git commit` — create a commit with the given message.
 */
export async function commit(
  message: string,
  options: GitOptions = {},
): Promise<string> {
  if (!message) {
    throw new Error("Commit message must not be empty");
  }
  const { stdout } = await gitExec(["commit", "-m", message], options);
  return stdout;
}

/**
 * `git push` — push to remote.
 */
export async function push(
  options: GitOptions & { remote?: string; branch?: string; setUpstream?: boolean } = {},
): Promise<string> {
  const { remote = "origin", branch, setUpstream = false, ...gitOpts } = options;
  const args = ["push"];
  if (setUpstream) args.push("-u");
  args.push(remote);
  if (branch) args.push(branch);

  const { stdout, stderr } = await gitExec(args, gitOpts);
  // git push writes progress to stderr
  return stdout || stderr;
}

/**
 * `git pull` — pull from remote.
 */
export async function pull(
  options: GitOptions & { remote?: string; branch?: string } = {},
): Promise<string> {
  const { remote = "origin", branch, ...gitOpts } = options;
  const args = ["pull", remote];
  if (branch) args.push(branch);

  const { stdout } = await gitExec(args, gitOpts);
  return stdout;
}

/**
 * `git checkout` — switch branches or restore files.
 */
export async function checkout(
  target: string,
  options: GitOptions & { create?: boolean } = {},
): Promise<string> {
  const { create = false, ...gitOpts } = options;
  const args = ["checkout"];
  if (create) args.push("-b");
  args.push(target);

  const { stdout, stderr } = await gitExec(args, gitOpts);
  return stdout || stderr;
}

/**
 * `git branch` — list, create, or delete branches.
 */
export async function branch(
  options: GitOptions & { name?: string; delete?: boolean; list?: boolean } = {},
): Promise<string> {
  const { name, delete: del = false, list = false, ...gitOpts } = options;
  const args = ["branch"];

  if (list || (!name && !del)) {
    // list mode
    const { stdout } = await gitExec(args, gitOpts);
    return stdout;
  }

  if (del && name) {
    args.push("-d", name);
  } else if (name) {
    args.push(name);
  }

  const { stdout } = await gitExec(args, gitOpts);
  return stdout;
}

/**
 * `git rev-parse` — resolve refs to hashes, check if inside a repo, etc.
 */
export async function revParse(
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  const { stdout } = await gitExec(["rev-parse", ...args], options);
  return stdout;
}
