// src/agent/types.ts — Agent-layer types (config, runtime contract)

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SandboxConfig } from "../legacy/sandbox/config.js";
import type { AgentToolSettings } from "../tools/types.js";
import type { DefaultSessionStore } from "../legacy/core/session-store.js";

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
  /** Explicit workspace directory (#214). When omitted, defaults to ${ISOTOPES_HOME}/workspace-${id}. */
  workspace?: string;
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

// ---------------------------------------------------------------------------
// Runtime contract — RegisteredAgent / SendMessageRequest / RunInfo
// ---------------------------------------------------------------------------

export type RunStatus = "created" | "running" | "awaiting" | "completed" | "failed" | "cancelled";

export type AgentSessionKind = "root" | "leaf";

/** "always-new": fresh session per send_message call.
 *  "parent-reuse": same `(caller, parentSessionId)` reuses one target
 *  session across calls; falls back to fresh when no parentSessionId. */
export type AgentSessionPolicy = "always-new" | "parent-reuse";

export interface RegisteredAgent {
  readonly id: string;
  config: AgentConfig;
  readonly sessionStore: DefaultSessionStore;
  readonly capabilities: {
    tools: string[];
    canBeAddressed: boolean;
  };
  /** Defaults to "parent-reuse". */
  readonly sessionPolicy?: AgentSessionPolicy;
}

export interface SendMessageRequest {
  to: string;
  sessionId?: string;
  content: string;
  from?: { agentId: string; displayName?: string };
  parentSessionId?: string;
  cwd?: string;
  timeoutSeconds?: number;
  leafContext?: {
    /** Parent's filtered tools (parent's tools minus denied for spawn). */
    tools: AgentTool[];
    extraSystemPrompt?: string;
  };
  /** Fires once after run is registered, before any AgentEvent yields.
   * Use to wire side-channel UI (Discord thread, audit) by runId. */
  onRunStart?: (runId: string) => void;
  /** Fires when `runtime.cancel(runId, { reason })` runs. Lets the caller
   * shape the LLM-facing result string (e.g. "user cancel — don't retry"). */
  onCancel?: (reason: string) => void;
}

export interface RunInfo {
  runId: string;
  agentId: string;
  kind: AgentSessionKind;
  sessionId: string;
  startedAt: number;
  parentSessionId?: string;
}
