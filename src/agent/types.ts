// src/agent/types.ts — Agent-layer types (config, runtime contract)

import type { KnownProvider } from "@mariozechner/pi-ai";
import type { SandboxConfig } from "../legacy/sandbox/config.js";
import type { Tool, AgentToolSettings } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Provider config (single global provider; agents pick model only)
// ---------------------------------------------------------------------------

/**
 * LLM provider connection. Configured once at the top of isotopes.yaml.
 *
 * - `type` is a pi-ai provider key (e.g. "anthropic", "openai", "github-copilot",
 *   "amazon-bedrock"). The full set is pi-ai's `KnownProvider` union (23 values
 *   today). Custom strings are allowed if a custom provider plugin registers one
 *   — same `KnownProvider | string` pattern pi-ai uses for `Provider`.
 * - `defaultModel` is the model used by agents that don't specify their own.
 * - `baseUrl` / `headers` cover proxy / gateway scenarios — replaces the old
 *   `*-proxy` type variants.
 *
 * Per-agent overrides are no longer supported — agents pick a model only.
 */
export interface ProviderConfig {
  type: KnownProvider | (string & {});
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
  tools?: Tool[];
  toolSettings?: AgentToolSettings;
  /** Model id (e.g. "claude-sonnet-4.5"). Falls back to provider.defaultModel. */
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
   * - 'send-message': Force all code changes through send_message (removes write_file, edit)
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
