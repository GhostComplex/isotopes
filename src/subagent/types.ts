// src/subagent/types.ts — Type definitions for sub-agent spawning via acpx
// Defines agent types, spawn options, event types, and result structures.

import type { SubagentPermissionMode } from "../core/config.js";

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/** Supported acpx agent backends */
export type AcpxAgent =
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "copilot"
  | "opencode"
  | "kimi"
  | "qwen";

/** All known acpx agent values for validation */
export const ACPX_AGENTS: ReadonlySet<string> = new Set<string>([
  "claude",
  "codex",
  "gemini",
  "cursor",
  "copilot",
  "opencode",
  "kimi",
  "qwen",
]);

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

/** Options for spawning an acpx sub-agent */
export interface AcpxSpawnOptions {
  /** Which agent backend to use */
  agent: AcpxAgent;
  /** The prompt to send to the agent */
  prompt: string;
  /** Working directory for the agent process */
  cwd: string;
  /** Model override (e.g., "claude-sonnet-4-20250514") */
  model?: string;
  /**
   * @deprecated Use permissionMode instead.
   * Auto-approve all tool calls. Default: true
   */
  approveAll?: boolean;
  /**
   * Permission mode for tool execution (M8)
   * - "skip" — Use --dangerously-skip-permissions (full access, no prompts)
   * - "allowlist" — Use --allowedTools with configured list (recommended)
   * - "default" — Use claude CLI defaults (interactive prompts)
   * Default: "allowlist" (inherited from backend config)
   */
  permissionMode?: SubagentPermissionMode;
  /**
   * Tool allowlist for "allowlist" permission mode (M8)
   * Default: inherited from backend config
   */
  allowedTools?: string[];
  /** Timeout in seconds for the entire run */
  timeout?: number;
  /** Maximum number of agent turns */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Types of events emitted during sub-agent execution */
export type AcpxEventType =
  | "start"
  | "message"
  | "tool_use"
  | "tool_result"
  | "error"
  | "done";

/** A single event from a running sub-agent */
export interface AcpxEvent {
  /** Event type */
  type: AcpxEventType;
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
  /** Process exit code (for "done" events) */
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Final result after sub-agent execution completes */
export interface AcpxResult {
  /** Whether the sub-agent completed successfully */
  success: boolean;
  /** Final concatenated output (assistant messages) */
  output?: string;
  /** Error message if the run failed */
  error?: string;
  /** All events emitted during the run */
  events: AcpxEvent[];
  /** Process exit code */
  exitCode: number;
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
  agent: AcpxAgent;
  /** The prompt to send to the agent */
  prompt: string;
  /** Working directory for the agent process */
  cwd: string;
  /** Discord channel to send output to */
  channelId: string;
  /** Whether to create a thread for output */
  useThread?: boolean;
  /** Whether to show tool call details */
  showToolCalls?: boolean;
  /** Model override */
  model?: string;
  /**
   * @deprecated Use permissionMode instead.
   * Auto-approve all tool calls
   */
  approveAll?: boolean;
  /**
   * Permission mode for tool execution (M8)
   * - "skip" — Use --dangerously-skip-permissions (full access, no prompts)
   * - "allowlist" — Use --allowedTools with configured list (recommended)
   * - "default" — Use claude CLI defaults (interactive prompts)
   */
  permissionMode?: SubagentPermissionMode;
  /**
   * Tool allowlist for "allowlist" permission mode (M8)
   */
  allowedTools?: string[];
  /** Timeout in seconds */
  timeout?: number;
  /** Maximum number of agent turns */
  maxTurns?: number;
}
