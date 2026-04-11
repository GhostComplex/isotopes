/**
 * @module isotopes
 *
 * Public API for the Isotopes agent framework.
 *
 * This module re-exports all types, classes, and functions that constitute
 * the library's public surface. Consumers should import from `"isotopes"`
 * (this entry point) rather than reaching into internal paths.
 */

/** Semantic version of the Isotopes library. */
export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type {
  Message,
  MessageContentBlock,
  Tool,
  AgentEvent,
  ProviderConfig,
  AgentConfig,
  AgentInstance,
  AgentCore,
  AgentManager,
  Session,
  SessionMetadata,
  SessionConfig,
  SessionStore,
  SessionStoreConfig,
  Transport,
  CompactionMode,
  CompactionConfig,
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

export { textContent, messageContentToPlainText } from "./core/types.js";

// ---------------------------------------------------------------------------
// Core implementations
// ---------------------------------------------------------------------------

export { PiMonoCore } from "./core/pi-mono.js";
export { DefaultAgentManager } from "./core/agent-manager.js";
export type { AgentCreateOptions } from "./core/agent-manager.js";
export { DefaultSessionStore } from "./core/session-store.js";
export { ToolRegistry, createEchoTool, createTimeTool, createSubagentTool, createWorkspaceToolsWithGuards } from "./core/tools.js";
export type { ToolHandler, ToolEntry, SubagentToolOptions } from "./core/tools.js";

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
  normalizeDiscordAccounts,
  resolveAcpConfig,
  resolveSandboxConfigFromFile,
  resolveSubagentConfig,
  DEFAULT_SUBAGENT_ALLOWED_TOOLS,
} from "./core/config.js";
export type {
  IsotopesConfigFile,
  AgentConfigFile,
  AgentDefaultsConfigFile,
  DiscordConfigFile,
  DiscordAccountConfigFile,
  ProviderConfigFile,
  ThreadBindingConfigFile,
  AcpConfigFile,
  CronJobConfigFile,
  SandboxConfigFile,
  SandboxDockerConfigFile,
  SubagentConfigFile,
  SubagentPermissionMode,
  SubagentStreamingConfigFile,
  ResolvedSubagentConfig,
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

export { DiscordTransportManager } from "./transports/discord-manager.js";
export type { DiscordTransportManagerConfig, DiscordSharedConfig } from "./transports/discord-manager.js";

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
  getLogsDir,
  getWorkspacePath,
  getConfigPath,
  getSessionsDir as getAgentSessionsDir,
  ensureDirectories,
  ensureWorkspaceDir,
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
  createSelfIterationTools,
  ITERATE_SELF_TOOL,
  CREATE_SKILL_TOOL,
  APPEND_MEMORY_TOOL,
  DEFAULT_SELF_ITERATION_FILES,
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
  SelfIterationConfig,
} from "./tools/index.js";

// ---------------------------------------------------------------------------
// Web API
// ---------------------------------------------------------------------------

export { ApiServer } from "./api/index.js";
export type { ApiServerConfig, ApiRequest, ApiError, RouteDeps, RouteHandler } from "./api/index.js";

// ---------------------------------------------------------------------------
// Workspace Hot-Reload
// ---------------------------------------------------------------------------

export {
  WorkspaceWatcher,
  globToRegExp,
  matchesPatterns,
  matchesIgnorePatterns,
  ConfigReloader,
  HotReloadManager,
  WATCHED_PATTERNS,
  IGNORE_PATTERNS,
  seedWorkspaceTemplates,
  isBrandNewWorkspace,
  getWorkspaceTemplates,
  readWorkspaceState,
  writeWorkspaceState,
  isSetupComplete,
  reconcileWorkspaceState,
} from "./workspace/index.js";
export type {
  WatcherConfig,
  FileChange,
  ChangeHandler,
  ConfigReloadListener,
  HotReloadConfig,
  WorkspaceReloadedEvent,
  ReloadEventHandler,
  WorkspaceTemplate,
  WorkspaceState,
} from "./workspace/index.js";

// ---------------------------------------------------------------------------
// Sandbox Execution
// ---------------------------------------------------------------------------

export {
  resolveSandboxConfig,
  shouldSandbox,
  ContainerManager,
  SandboxExecutor,
} from "./sandbox/index.js";
export type {
  SandboxMode,
  WorkspaceAccess,
  DockerConfig,
  SandboxConfig,
  ContainerStatus,
  ContainerInfo,
  ExecResult,
  SandboxExecOptions,
} from "./sandbox/index.js";

// ---------------------------------------------------------------------------
// Sub-agent (acpx)
// ---------------------------------------------------------------------------

export {
  AcpxBackend,
  parseJsonLine,
  collectResult,
  DiscordSink,
  truncate,
  formatEvent,
  formatSummary,
  SubagentManager,
  ACPX_AGENTS,
} from "./subagent/index.js";
export type {
  AcpxAgent,
  AcpxSpawnOptions,
  AcpxEventType,
  AcpxEvent,
  AcpxResult,
  DiscordSinkConfig,
  SubagentTask,
  SendMessageFn,
  CreateThreadFn,
  AcpxBackendOptions,
} from "./subagent/index.js";

// ---------------------------------------------------------------------------
// Subagent Discord Context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

export {
  runWithSubagentContext,
  runWithSubagentContextAsync,
  getSubagentContext,
  hasSubagentContext,
} from "./core/subagent-context.js";
export type { SubagentDiscordContext } from "./core/subagent-context.js";
