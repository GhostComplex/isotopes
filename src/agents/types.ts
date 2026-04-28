// src/agents/types.ts — Public types for the unified AgentRuntime (#568).

import type { ProviderConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tools.js";
import type { AgentServiceCache } from "../core/pi-mono.js";
import type { DefaultSessionStore } from "../core/session-store.js";

export type RunStatus = "created" | "running" | "awaiting" | "completed" | "failed" | "cancelled";

export type AgentSessionKind = "root" | "leaf";

/** How a target agent handles incoming a2a messages when no explicit
 * sessionId is supplied:
 *   - "always-new":   each `send_message` call creates a fresh session
 *   - "parent-reuse": same caller's session reuses the same target session
 *                     (key = peer:${fromAgentId}:${parentSessionId}); falls
 *                     back to a fresh session when no parentSessionId is
 *                     available (heartbeat/cron triggers, transport-direct).
 */
export type AgentSessionPolicy = "always-new" | "parent-reuse";

/** An agent registered with the runtime. The runtime stores cache /
 * systemPrompt / sessionStore / tools so it can drive the agent's loop
 * without re-resolving them per message. */
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
  /** Defaults to "always-new" when omitted. */
  readonly sessionPolicy?: AgentSessionPolicy;
}

/** Single execution verb. `to` is a registered agent id (root session)
 * or the magic id `"subagent"` (ephemeral leaf, requires `leafContext`). */
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
}

export interface RunInfo {
  runId: string;
  agentId: string;
  kind: AgentSessionKind;
  sessionId: string;
  startedAt: number;
  parentSessionId?: string;
}
