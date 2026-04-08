// src/tools/github.ts — GitHub CLI (gh) wrapper for agent tooling
// Provides typed wrappers around common GitHub operations via the gh CLI.

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options common to all GitHub CLI commands (working directory, timeout). */
export interface GhOptions {
  /** Working directory for gh commands */
  cwd?: string;
  /** Maximum execution time in ms (default: 30_000) */
  timeout?: number;
}

/** A GitHub pull request. */
export interface PullRequest {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
}

/** A GitHub issue. */
export interface Issue {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/** A GitHub repository. */
export interface Repo {
  name: string;
  owner: string;
  description: string;
  url: string;
  defaultBranch: string;
  isPrivate: boolean;
}

/** Options for creating a pull request via `gh pr create`. */
export interface CreatePROptions {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

/** Options for creating an issue via `gh issue create`. */
export interface CreateIssueOptions {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

/** Options for submitting a PR review via `gh pr review`. */
export interface ReviewPROptions {
  number: number;
  event: "approve" | "request_changes" | "comment";
  body?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a gh CLI command and return the raw result.
 * Throws on non-zero exit code.
 */
async function ghExec(
  args: string[],
  options: GhOptions = {},
): Promise<string> {
  const { cwd, timeout = 30_000 } = options;
  const command = `gh ${args.join(" ")}`;

  const { stdout } = await execAsync(command, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout.trimEnd();
}

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

/**
 * List pull requests.
 */
export async function listPRs(
  options: GhOptions & { state?: "open" | "closed" | "merged" | "all"; limit?: number } = {},
): Promise<PullRequest[]> {
  const { state = "open", limit = 30, ...ghOpts } = options;
  const fields = "number,title,state,author,url,body,headRefName,baseRefName,createdAt,updatedAt";
  const raw = await ghExec(
    ["pr", "list", "--state", state, "--limit", String(limit), "--json", fields],
    ghOpts,
  );
  const items = JSON.parse(raw) as Array<Record<string, unknown>>;
  return items.map(normalizePR);
}

/**
 * Get a single pull request by number.
 */
export async function getPR(
  number: number,
  options: GhOptions = {},
): Promise<PullRequest> {
  const fields = "number,title,state,author,url,body,headRefName,baseRefName,createdAt,updatedAt";
  const raw = await ghExec(
    ["pr", "view", String(number), "--json", fields],
    options,
  );
  return normalizePR(JSON.parse(raw) as Record<string, unknown>);
}

/**
 * Create a pull request.
 */
export async function createPR(
  opts: CreatePROptions,
  ghOpts: GhOptions = {},
): Promise<PullRequest> {
  const args = ["pr", "create", "--title", opts.title];
  if (opts.body) args.push("--body", opts.body);
  if (opts.base) args.push("--base", opts.base);
  if (opts.head) args.push("--head", opts.head);
  if (opts.draft) args.push("--draft");

  // gh pr create outputs the URL; re-fetch for structured data
  const url = await ghExec(args, ghOpts);
  const prNumber = parseInt(url.split("/").pop() ?? "", 10);
  return getPR(prNumber, ghOpts);
}

/**
 * Merge a pull request.
 */
export async function mergePR(
  number: number,
  options: GhOptions & { method?: "merge" | "squash" | "rebase"; deleteAfter?: boolean } = {},
): Promise<string> {
  const { method = "squash", deleteAfter = true, ...ghOpts } = options;
  const args = ["pr", "merge", String(number), `--${method}`];
  if (deleteAfter) args.push("--delete-branch");

  return ghExec(args, ghOpts);
}

/**
 * Close a pull request without merging.
 */
export async function closePR(
  number: number,
  options: GhOptions = {},
): Promise<string> {
  return ghExec(["pr", "close", String(number)], options);
}

/**
 * Submit a review on a pull request.
 */
export async function reviewPR(
  opts: ReviewPROptions,
  ghOpts: GhOptions = {},
): Promise<string> {
  const eventFlag =
    opts.event === "approve"
      ? "--approve"
      : opts.event === "request_changes"
        ? "--request-changes"
        : "--comment";

  const args = ["pr", "review", String(opts.number), eventFlag];
  if (opts.body) args.push("--body", opts.body);

  return ghExec(args, ghOpts);
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * List issues.
 */
export async function listIssues(
  options: GhOptions & { state?: "open" | "closed" | "all"; limit?: number; labels?: string[] } = {},
): Promise<Issue[]> {
  const { state = "open", limit = 30, labels, ...ghOpts } = options;
  const fields = "number,title,state,author,url,body,labels,createdAt,updatedAt";
  const args = ["issue", "list", "--state", state, "--limit", String(limit), "--json", fields];
  if (labels && labels.length > 0) {
    args.push("--label", labels.join(","));
  }

  const raw = await ghExec(args, ghOpts);
  const items = JSON.parse(raw) as Array<Record<string, unknown>>;
  return items.map(normalizeIssue);
}

/**
 * Get a single issue by number.
 */
export async function getIssue(
  number: number,
  options: GhOptions = {},
): Promise<Issue> {
  const fields = "number,title,state,author,url,body,labels,createdAt,updatedAt";
  const raw = await ghExec(
    ["issue", "view", String(number), "--json", fields],
    options,
  );
  return normalizeIssue(JSON.parse(raw) as Record<string, unknown>);
}

/**
 * Create an issue.
 */
export async function createIssue(
  opts: CreateIssueOptions,
  ghOpts: GhOptions = {},
): Promise<Issue> {
  const args = ["issue", "create", "--title", opts.title];
  if (opts.body) args.push("--body", opts.body);
  if (opts.labels && opts.labels.length > 0) {
    args.push("--label", opts.labels.join(","));
  }
  if (opts.assignees && opts.assignees.length > 0) {
    args.push("--assignee", opts.assignees.join(","));
  }

  const url = await ghExec(args, ghOpts);
  const issueNumber = parseInt(url.split("/").pop() ?? "", 10);
  return getIssue(issueNumber, ghOpts);
}

/**
 * Close an issue.
 */
export async function closeIssue(
  number: number,
  options: GhOptions = {},
): Promise<string> {
  return ghExec(["issue", "close", String(number)], options);
}

/**
 * Add a comment to an issue.
 */
export async function commentIssue(
  number: number,
  body: string,
  options: GhOptions = {},
): Promise<string> {
  return ghExec(["issue", "comment", String(number), "--body", body], options);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Get current repository info.
 */
export async function getRepo(
  options: GhOptions = {},
): Promise<Repo> {
  const fields = "name,owner,description,url,defaultBranchRef,isPrivate";
  const raw = await ghExec(
    ["repo", "view", "--json", fields],
    options,
  );
  const data = JSON.parse(raw) as Record<string, unknown>;
  return normalizeRepo(data);
}

// ---------------------------------------------------------------------------
// Normalizers — flatten gh JSON output into our typed interfaces
// ---------------------------------------------------------------------------

function normalizePR(raw: Record<string, unknown>): PullRequest {
  const author = raw.author as Record<string, unknown> | undefined;
  return {
    number: raw.number as number,
    title: raw.title as string,
    state: raw.state as string,
    author: (author?.login as string) ?? "",
    url: raw.url as string,
    body: (raw.body as string) ?? "",
    headRefName: raw.headRefName as string,
    baseRefName: raw.baseRefName as string,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
}

function normalizeIssue(raw: Record<string, unknown>): Issue {
  const author = raw.author as Record<string, unknown> | undefined;
  const labels = (raw.labels as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    number: raw.number as number,
    title: raw.title as string,
    state: raw.state as string,
    author: (author?.login as string) ?? "",
    url: raw.url as string,
    body: (raw.body as string) ?? "",
    labels: labels.map((l) => l.name as string),
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
}

function normalizeRepo(raw: Record<string, unknown>): Repo {
  const owner = raw.owner as Record<string, unknown> | undefined;
  const defaultBranchRef = raw.defaultBranchRef as Record<string, unknown> | undefined;
  return {
    name: raw.name as string,
    owner: (owner?.login as string) ?? "",
    description: (raw.description as string) ?? "",
    url: raw.url as string,
    defaultBranch: (defaultBranchRef?.name as string) ?? "main",
    isPrivate: (raw.isPrivate as boolean) ?? false,
  };
}
