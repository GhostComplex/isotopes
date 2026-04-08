// src/index.ts — Isotopes public API
// Main entry point for library usage.

export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type {
  Message,
  Tool,
  AgentEvent,
  ProviderConfig,
  AgentConfig,
  AgentInstance,
  AgentCore,
  AgentManager,
  Session,
  SessionStore,
  Transport,
  GuildConfig,
  DiscordAccountConfig,
  ChannelsConfig,
  Binding,
  BindingMatch,
  BindingPeer,
  PeerKind,
  ThreadBindingConfig,
  ThreadBinding,
} from "./core/types.js";

// ---------------------------------------------------------------------------
// Core implementations
// ---------------------------------------------------------------------------

export { PiMonoCore } from "./core/pi-mono.js";
export { DefaultAgentManager } from "./core/agent-manager.js";
export { DefaultSessionStore } from "./core/session-store.js";
export { ToolRegistry, createEchoTool, createTimeTool } from "./core/tools.js";
export type { ToolHandler, ToolEntry } from "./core/tools.js";

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export {
  loadWorkspaceContext,
  buildSystemPrompt,
  ensureWorkspaceStructure,
  getSessionsDir,
  WORKSPACE_FILES,
  MEMORY_FILES,
} from "./core/workspace.js";
export type { WorkspaceContext } from "./core/workspace.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export {
  loadConfig,
  toAgentConfig,
  getDiscordToken,
  getDiscordGuildConfig,
  isRequireMention,
  resolveAcpConfig,
} from "./core/config.js";
export type {
  IsotopesConfigFile,
  AgentConfigFile,
  DiscordConfigFile,
  ProviderConfigFile,
  ThreadBindingConfigFile,
  AcpConfigFile,
  CronJobConfigFile,
} from "./core/config.js";

// ---------------------------------------------------------------------------
// Bindings resolution
// ---------------------------------------------------------------------------

export { resolveBinding, resolveAllBindings } from "./core/bindings.js";
export type { BindingQuery } from "./core/bindings.js";

// ---------------------------------------------------------------------------
// Thread bindings
// ---------------------------------------------------------------------------

export { ThreadBindingManager } from "./core/thread-bindings.js";
export type { ThreadBindingCallback } from "./core/thread-bindings.js";

// ---------------------------------------------------------------------------
// ACP (Agent Communication Protocol)
// ---------------------------------------------------------------------------

export { AcpSessionManager } from "./acp/index.js";
export type {
  AcpConfig,
  AcpBackend,
  AcpSession,
  AcpSessionStatus,
  AcpMessage,
  AcpSessionEvent,
  AcpSessionCallback,
} from "./acp/index.js";

export { AgentMessageBus } from "./acp/index.js";
export type {
  AgentMessage,
  MessageDelivery,
  MessageHandler,
} from "./acp/index.js";

export { SharedContextManager } from "./acp/index.js";
export type { SharedContext } from "./acp/index.js";

// ---------------------------------------------------------------------------
// Mention detection
// ---------------------------------------------------------------------------

export {
  shouldRespondToMessage,
  resolveRequireMention,
} from "./core/mention.js";
export type { MentionContext } from "./core/mention.js";

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export { DiscordTransport } from "./transports/discord.js";
export type { DiscordTransportConfig } from "./transports/discord.js";

export { FeishuTransport, extractTextFromFeishuMessage, buildFeishuSessionKey, stripFeishuMentions, isBotMentioned, resolveAgentId } from "./transports/feishu.js";
export type { FeishuTransportConfig, FeishuMessageEvent } from "./transports/feishu.js";

// ---------------------------------------------------------------------------
// Automation (cron)
// ---------------------------------------------------------------------------

export {
  CronScheduler,
  parseCronExpression,
  getNextRun,
  matchesCron,
} from "./automation/index.js";
export type {
  CronSchedule,
  CronJob,
  CronAction,
  CronJobCallback,
  CronJobInput,
} from "./automation/index.js";

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export { DaemonProcess } from "./daemon/index.js";
export type { DaemonStatus, DaemonOptions } from "./daemon/index.js";

export { ServiceManager, getPlatform } from "./daemon/index.js";
export type { ServiceConfig, ServicePlatform } from "./daemon/index.js";

export { LogRotator } from "./daemon/index.js";
export type { LogRotationConfig } from "./daemon/index.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export { logger, loggers, createLogger } from "./core/logger.js";
export type { Logger, LogLevel } from "./core/logger.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export {
  getIsotopesHome,
  getWorkspacesDir,
  getLogsDir,
  getWorkspacePath,
  getConfigPath,
  getSessionsDir as getAgentSessionsDir,
  ensureDirectories,
  ensureWorkspaceDir,
  resolveWorkspacePath,
} from "./core/paths.js";

// ---------------------------------------------------------------------------
// Git / GitHub tools
// ---------------------------------------------------------------------------

export {
  gitStatus,
  gitLog,
  gitDiff,
  gitAdd,
  gitCommit,
  gitPush,
  gitPull,
  gitCheckout,
  gitBranch,
  gitRevParse,
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
} from "./tools/index.js";
export type {
  GitOptions,
  GitStatusResult,
  GitLogEntry,
  GitExecResult,
  GhOptions,
  PullRequest,
  Issue,
  Repo,
  CreatePROptions,
  CreateIssueOptions,
  ReviewPROptions,
} from "./tools/index.js";

// ---------------------------------------------------------------------------
// Workspace Hot-Reload
// ---------------------------------------------------------------------------

export {
  WorkspaceWatcher,
  globToRegExp,
  matchesPatterns,
  matchesIgnorePatterns,
  ConfigReloader,
} from "./workspace/index.js";
export type {
  WatcherConfig,
  FileChange,
  ChangeHandler,
  ConfigReloadListener,
} from "./workspace/index.js";
