// src/tools/index.ts — Barrel exports for git and GitHub tools

export {
  status as gitStatus,
  log as gitLog,
  diff as gitDiff,
  add as gitAdd,
  commit as gitCommit,
  push as gitPush,
  pull as gitPull,
  checkout as gitCheckout,
  branch as gitBranch,
  revParse as gitRevParse,
} from "./git.js";
export type {
  GitOptions,
  GitStatusResult,
  GitLogEntry,
  GitExecResult,
} from "./git.js";

export {
  listPRs,
  getPR,
  createPR,
  mergePR,
  closePR,
  reviewPR,
  listIssues,
  getIssue,
  createIssue,
  closeIssue,
  commentIssue,
  getRepo,
} from "./github.js";
export type {
  GhOptions,
  PullRequest,
  Issue,
  Repo,
  CreatePROptions,
  CreateIssueOptions,
  ReviewPROptions,
} from "./github.js";

export {
  spawnSubagent,
  cancelSubagent,
  hasRunningSubagents,
  getActiveSubagentCount,
  getSupportedAgents,
  initSubagentBackend,
} from "./subagent.js";
export type {
  SpawnSubagentOptions,
  SpawnSubagentResult,
  SubagentBackendConfig,
} from "./subagent.js";

export { createWebFetchTool, createWebSearchTool } from "./web.js";
export type { SearchResult } from "./web.js";

export {
  ProcessRegistry,
  createExecTool,
  createProcessListTool,
  createProcessKillTool,
  createExecTools,
} from "./exec.js";
export type { ExecToolOptions, ProcessInfo } from "./exec.js";

export {
  createMessageReactTool,
  createReactTools,
} from "./react.js";
export type { ReactToolContext } from "./react.js";
