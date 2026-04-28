// Public types for the unified AgentRuntime.

import type { ProviderConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tools.js";
import type { AgentServiceCache } from "../core/pi-mono.js";
import type { DefaultSessionStore } from "../core/session-store.js";

export type RunStatus = "created" | "running" | "awaiting" | "completed" | "failed" | "cancelled";

export type AgentSessionKind = "root" | "leaf";

/** "always-new": fresh session per send_message call.
 *  "parent-reuse": same `(caller, parentSessionId)` reuses one target
 *  session across calls; falls back to fresh when no parentSessionId. */
export type AgentSessionPolicy = "always-new" | "parent-reuse";

export interface RegisteredAgent {
  readonly id: string;
  readonly cache: AgentServiceCache;
  readonly systemPrompt: string;
  readonly sessionStore: DefaultSessionStore;
  readonly tools: ToolRegistry;
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
    provider: ProviderConfig;
    tools: ToolRegistry;
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
