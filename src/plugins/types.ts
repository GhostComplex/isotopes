// src/plugins/types.ts — Plugin system interfaces
// Defines the manifest, lifecycle, hooks, and API surface for Isotopes plugins.

import type { Logger } from "../core/logger.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Tool, Transport } from "../core/types.js";
import type { ToolHandler } from "../core/tools.js";
import type { DefaultAgentManager } from "../core/agent-manager.js";
import type { SessionStoreManager } from "../core/session-store-manager.js";
import type { IsotopesConfigFile } from "../core/config.js";

// ---------------------------------------------------------------------------
// Plugin manifest (isotopes.plugin.json)
// ---------------------------------------------------------------------------

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
}

// ---------------------------------------------------------------------------
// Plugin module
// ---------------------------------------------------------------------------

export interface IsotopesPlugin {
  register(api: IsotopesPluginApi): void | Promise<void>;
  unregister?(): void | Promise<void>;
}

export type IsotopesPluginModule =
  | IsotopesPlugin
  | ((api: IsotopesPluginApi) => void | Promise<void>);

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export type HookName =
  | "before_agent_start"
  | "agent_end"
  | "before_tool_call"
  | "after_tool_call"
  | "message_received"
  | "message_sending"
  | "session_start"
  | "session_end";

export interface HookPayloads {
  before_agent_start: { agentId: string };
  agent_end: { agentId: string; stopReason?: string };
  before_tool_call: { agentId: string; toolName: string; args: unknown };
  after_tool_call: { agentId: string; toolName: string; args: unknown; result: string };
  message_received: { agentId: string; sessionId: string; message: AgentMessage };
  message_sending: { agentId: string; sessionId: string; message: AgentMessage };
  session_start: { agentId: string; sessionId: string };
  session_end: { agentId: string; sessionId: string };
}

// ---------------------------------------------------------------------------
// UI plugin config
// ---------------------------------------------------------------------------

export interface UIPluginConfig {
  id: string;
  label: string;
  staticDir: string;
  mountPath?: string;
  spaFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

export type TransportFactory = (ctx: TransportFactoryContext) => Transport | Promise<Transport>;

export interface TransportFactoryContext {
  agentManager: DefaultAgentManager;
  sessionStoreManager: SessionStoreManager;
  config: IsotopesConfigFile;
}

// ---------------------------------------------------------------------------
// Tool plugin types
// ---------------------------------------------------------------------------

export interface PluginToolContext {
  agentId: string;
  workspacePath: string;
  config?: Record<string, unknown>;
}

export type PluginToolFactory = (
  ctx: PluginToolContext,
) => { tool: Tool; handler: ToolHandler } | { tool: Tool; handler: ToolHandler }[] | null | undefined;

// ---------------------------------------------------------------------------
// Plugin API — the object passed to plugin.register()
// ---------------------------------------------------------------------------

export interface IsotopesPluginApi {
  registerTransport(id: string, factory: TransportFactory): void;
  registerUI(config: UIPluginConfig): void;
  registerTool(
    tool: { tool: Tool; handler: ToolHandler } | PluginToolFactory,
  ): void;
  on<H extends HookName>(
    hook: H,
    handler: (payload: HookPayloads[H]) => void | Promise<void>,
  ): () => void;
  getConfig(): Record<string, unknown> | undefined;
  log: Logger;
}

// ---------------------------------------------------------------------------
// Plugin config in isotopes.yaml
// ---------------------------------------------------------------------------

export interface PluginConfigEntry {
  enabled?: boolean;
  config?: Record<string, unknown>;
}
