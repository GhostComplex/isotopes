import type { SandboxConfig } from "./middleware/sandbox-config.js";
import type { AgentToolSettings } from "./tools/types.js";
import type { DefaultSessionStore } from "./pi/session-store.js";
import type { LazyChannelContext } from "../channels/types.js";

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
  /** Default "pi". */
  runner?: "pi" | "claude";
  /** Defaults to ${ISOTOPES_HOME}/workspace-${id}. */
  workspace?: string;
  toolSettings?: AgentToolSettings;
  model?: string;
  sandbox?: SandboxConfig;
  /** Default false. */
  spawnable?: boolean;
  /** Default "parent-reuse". */
  sessionPolicy?: "always-new" | "parent-reuse";
}

/** "always-new": fresh session per spawn_agent tool call.
 *  "parent-reuse": same `(caller, parentSessionId)` reuses one target
 *  session across calls; falls back to fresh when no parentSessionId. */
export type AgentSessionPolicy = "always-new" | "parent-reuse";

export interface RegisteredAgent {
  readonly id: string;
  config: AgentConfig;
  /** Absent → in-memory session (no continuity across calls). */
  readonly sessionStore?: DefaultSessionStore;
  /** Defaults to "parent-reuse". */
  readonly sessionPolicy?: AgentSessionPolicy;
  readonly spawnableAgentIds?: readonly string[];
  readonly channelContext?: LazyChannelContext;
}

export interface RunRequest {
  to: string;
  sessionId?: string;
  content: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  from?: { agentId: string; displayName?: string };
  parentSessionId?: string;
  cwd?: string;
  timeoutSeconds?: number;
  extraSystemPrompt?: string;
  /** Fires once after run is registered, before any AgentEvent yields.
   * Use to wire side-channel UI (Discord thread, audit) by sessionId. */
  onRunStart?: (sessionId: string) => void;
  /** Fires when `runtime.cancel(sessionId, { reason })` runs. Lets the caller
   * shape the LLM-facing result string (e.g. "user cancel — don't retry"). */
  onCancel?: (reason: string) => void;
}

export interface RunInfo {
  runId: string;
  agentId: string;
  sessionId: string;
  startedAt: number;
  /** Spawn-tree depth: 1 = top-level (no parent), 2 = first child, etc. */
  depth: number;
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
