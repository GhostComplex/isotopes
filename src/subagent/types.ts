// src/subagent/types.ts — Type definitions for sub-agent spawning
// Defines agent types, spawn options, event types, and result structures.

import type { SubagentPermissionMode } from "../core/config.js";
import type { ProviderConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tools.js";

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/** Supported subagent backends. */
export type SubagentAgent = "claude" | "builtin";

/** All known subagent values for validation */
export const SUBAGENT_AGENTS: ReadonlySet<string> = new Set<string>(["claude", "builtin"]);

/**
 * Role of a builtin subagent run. Drives tool capabilities.
 * - "leaf"         — terminal worker; cannot spawn nested subagents.
 * - "orchestrator" — reserved for future nesting; currently unused in v1.
 */
export type SubagentRole = "leaf" | "orchestrator";

/** Builtin-backend-specific spawn options. */
export interface BuiltinSubagentOptions {
  /** Provider config inherited from the parent agent. */
  provider: ProviderConfig;
  /** Parent agent's tool registry; the runner filters this by role. */
  tools: ToolRegistry;
  /** Role for capability gating. Default: "leaf". */
  role?: SubagentRole;
  /** Optional extra system prompt fragment appended after the base subagent prompt. */
  extraSystemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

/** Options for spawning a sub-agent */
export interface SubagentSpawnOptions {
  /** Which agent backend to use */
  agent: SubagentAgent;
  /** The prompt to send to the agent */
  prompt: string;
  /** Working directory for the agent */
  cwd: string;
  /** Model override (e.g., "claude-sonnet-4-5-20250929") */
  model?: string;
  /**
   * Permission mode for tool execution.
   * - "skip" — bypass permissions (full access, no prompts)
   * - "allowlist" — SDK default mode + allowedTools list (recommended)
   * - "default" — SDK default mode without allowedTools
   */
  permissionMode?: SubagentPermissionMode;
  /** Tool allowlist for "allowlist" permission mode */
  allowedTools?: string[];
  /** Timeout in seconds for the entire run */
  timeout?: number;
  /** Maximum number of agent turns */
  maxTurns?: number;
  /** Builtin-backend-specific options. Required when agent === "builtin". */
  builtin?: BuiltinSubagentOptions;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Types of events emitted during sub-agent execution */
export type SubagentEventType =
  | "start"
  | "message"
  | "tool_use"
  | "tool_result"
  | "error"
  | "done";

/** A single event from a running sub-agent */
export interface SubagentEvent {
  /** Event type */
  type: SubagentEventType;
  /** Message content (for "message" events) */
  content?: string;
  /** Tool name (for "tool_use" events) */
  toolName?: string;
  /** Tool input parameters (for "tool_use" events) */
  toolInput?: unknown;
  /** Tool result text (for "tool_result" events) */
  toolResult?: string;
  /** Error message (for "error" events) */
  error?: string;
  /** Exit code (for "done" events; 0 = success, 1 = error) */
  exitCode?: number;
  /** Cost in USD (for "done" events, if available) */
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Final result after sub-agent execution completes */
export interface SubagentResult {
  /** Whether the sub-agent completed successfully */
  success: boolean;
  /** Final concatenated output (assistant messages) */
  output?: string;
  /** Error message if the run failed */
  error?: string;
  /** All events emitted during the run */
  events: SubagentEvent[];
  /** Exit code */
  exitCode: number;
  /** Cost in USD (if available from the agent) */
  costUsd?: number;
  /** Runtime duration in milliseconds */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Discord sink config
// ---------------------------------------------------------------------------

/** Configuration for how sub-agent output is displayed in Discord */
export interface DiscordSinkConfig {
  /** Whether to show tool call details */
  showToolCalls: boolean;
  /** Whether to show thinking/reasoning content */
  showThinking: boolean;
  /** Whether to create a thread for sub-agent output */
  useThread: boolean;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** A sub-agent task combining spawn options with Discord routing */
export interface SubagentTask {
  /** Unique task identifier */
  id: string;
  /** Which agent backend to use */
  agent: SubagentAgent;
  /** The prompt to send to the agent */
  prompt: string;
  /** Working directory for the agent */
  cwd: string;
  /** Discord channel to send output to */
  channelId: string;
  /** Whether to create a thread for output */
  useThread?: boolean;
  /** Whether to show tool call details */
  showToolCalls?: boolean;
  /** Model override */
  model?: string;
  /** Permission mode for tool execution */
  permissionMode?: SubagentPermissionMode;
  /** Tool allowlist for "allowlist" permission mode */
  allowedTools?: string[];
  /** Timeout in seconds */
  timeout?: number;
  /** Maximum number of agent turns */
  maxTurns?: number;
}
