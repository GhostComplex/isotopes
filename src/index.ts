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
} from "./core/config.js";
export type {
  IsotopesConfigFile,
  AgentConfigFile,
  DiscordConfigFile,
  ProviderConfigFile,
} from "./core/config.js";

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

export { FeishuTransport, extractTextFromFeishuMessage, buildFeishuSessionKey } from "./transports/feishu.js";
export type { FeishuTransportConfig, FeishuMessageEvent } from "./transports/feishu.js";

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
