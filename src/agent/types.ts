// src/agent/types.ts — Agent-layer types (config, runtime contract)

import type { SandboxConfig } from "../legacy/sandbox/config.js";
import type { AgentToolSettings } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Provider config (single global provider; agents pick model only)
// ---------------------------------------------------------------------------

export type ProviderType = "anthropic" | "openai" | "github-copilot";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

/** Complete configuration needed to create an agent instance. */
export interface AgentConfig {
  id: string;
  toolSettings?: AgentToolSettings;
  model?: string;
  /** Context compaction configuration */
  compaction?: CompactionConfig;
  /** Sandbox execution configuration */
  sandbox?: SandboxConfig;
  /** Heartbeat interval in milliseconds (0 or undefined = disabled) */
  heartbeatInterval?: number;
  /** Custom heartbeat prompt (overrides the default) */
  heartbeatPrompt?: string;
  /**
   * Coding mode controls how the agent handles code modifications:
   * - 'send-message': Force all code changes through send_message (removes write/edit)
   * - 'direct': Agent can modify files directly (default behavior)
   * - 'auto': Agent chooses based on task complexity (default)
   */
  codingMode?: "send-message" | "direct" | "auto";
  /** Whether this agent can be spawned by other agents. Default: false */
  spawnable?: boolean;
  /** "parent-reuse" (default) | "always-new". See AgentSessionPolicy. */
  sessionPolicy?: "always-new" | "parent-reuse";
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** Compaction mode for managing context window size */
export type CompactionMode = 'off' | 'safeguard' | 'aggressive';

/** Configuration for context compaction */
export interface CompactionConfig {
  mode: CompactionMode;
  contextWindow?: number;
  threshold?: number;
  preserveRecent?: number;
  /** Absolute token reserve before compaction triggers. Overrides threshold if set. */
  reserveTokens?: number;
}
