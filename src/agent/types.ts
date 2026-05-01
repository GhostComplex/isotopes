import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SandboxConfig } from "../legacy/sandbox/config.js";
import type { AgentToolSettings } from "../tools/types.js";
import type { DefaultSessionStore } from "../legacy/core/session-store.js";

export type ProviderType = "anthropic" | "openai" | "github-copilot";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

export interface AgentConfig {
  id: string;
  /** Defaults to ${ISOTOPES_HOME}/workspace-${id} (#214). */
  workspace?: string;
  toolSettings?: AgentToolSettings;
  model?: string;
  compaction?: CompactionConfig;
  sandbox?: SandboxConfig;
  /** Heartbeat interval in milliseconds (0 or undefined = disabled) */
  heartbeatInterval?: number;
  /** Overrides the default heartbeat prompt. */
  heartbeatPrompt?: string;
  /**
   * - 'send-message': force code changes through send_message (removes write/edit)
   * - 'direct': agent edits files directly
   * - 'auto' (default): agent picks based on task
   */
  codingMode?: "send-message" | "direct" | "auto";
  /** Default false. */
  spawnable?: boolean;
  /** Defaults to "parent-reuse". */
  sessionPolicy?: "always-new" | "parent-reuse";
}

export type CompactionMode = 'off' | 'safeguard' | 'aggressive';

export interface CompactionConfig {
  mode: CompactionMode;
  contextWindow?: number;
  threshold?: number;
  preserveRecent?: number;
  /** Absolute token reserve before compaction triggers. Overrides threshold if set. */
  reserveTokens?: number;
}


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

export interface RunRequest {
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

/** Caller-fixable input error. Tool handlers should surface as `[error]`
 * instead of `[failed]` so the LLM doesn't retry. */
export class RunValidationError extends Error {
  readonly isValidationError = true;
  constructor(message: string) {
    super(message);
    this.name = "RunValidationError";
  }
}
