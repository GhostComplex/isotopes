import type { ProviderConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tools.js";
import type { SpawnPermissionMode } from "../core/config.js";
import type { AgentServiceCache } from "../core/pi-mono.js";
import type { DefaultSessionStore } from "../core/session-store.js";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

export type RunStatus = "created" | "running" | "awaiting" | "completed" | "failed" | "cancelled";

// ---------------------------------------------------------------------------
// New unified runtime types (issue #568). Coexist with the legacy RunEvent /
// RunOptions / BuiltinOptions surface during the migration; legacy types
// will be removed in a follow-up commit once all callers move over.
// ---------------------------------------------------------------------------

export type AgentSessionKind = "root" | "leaf";

/**
 * An agent registered with the runtime. The minimal public contract is `id`
 * + `capabilities`; the runtime also stores execution-related fields
 * (cache, systemPrompt, sessionStore, tools) so it can drive the agent's
 * loop without re-resolving them per message.
 */
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
}

/**
 * Single execution verb. `to` is either a registered agent id (root
 * session) or the magic id `"subagent"` (ephemeral leaf session).
 *
 * `leafContext` is required when `to === "subagent"` because leaf sessions
 * inherit the caller's provider + filtered tool set.
 */
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

export type RunEvent =
  | { type: "run:start" }
  | { type: "run:message"; content: string }
  | { type: "run:tool_use"; toolName: string; toolInput?: unknown }
  | { type: "run:tool_result"; toolName: string; toolResult: string; isError?: boolean }
  | { type: "run:error"; error: string }
  | { type: "run:done"; exitCode: number; costUsd?: number };

export interface RunResult {
  success: boolean;
  output?: string;
  error?: string;
  events: RunEvent[];
  exitCode: number;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Builtin runner payload. Two modes:
 *
 * - "subagent": fire-and-forget agent. Uses the parent's provider and
 *   a filtered subset of the parent's tools. The system prompt is the
 *   generic `buildSpawnAgentSystemPrompt()` preamble + task. By
 *   convention spawned via the magic agent id "subagent" so its run
 *   sessions land in `~/.isotopes/agents/subagent/sessions/`.
 *
 * - "named": spawn into an existing named agent's full identity. Uses
 *   the target agent's `AgentServiceCache` (which already owns its
 *   provider and tool registry) and the target's already-assembled
 *   system prompt (SOUL.md/MEMORY.md/TOOLS.md/tool guards merged at
 *   init time). Run sessions land in the target agent's own
 *   `sessions/` directory alongside its chat sessions.
 *
 * Both modes accept an optional `sessionManager`: when provided, the
 * SDK persists the conversation through it (structured messages,
 * resumable in principle); when omitted, the runner falls back to
 * `SessionManager.inMemory()` (transient).
 */
export type BuiltinOptions =
  | {
      mode: "subagent";
      provider: ProviderConfig;
      tools: ToolRegistry;
      extraSystemPrompt?: string;
      sessionManager?: SessionManager;
    }
  | {
      mode: "named";
      cache: AgentServiceCache;
      systemPrompt: string;
      sessionManager?: SessionManager;
    };

export type OnCompleteCallback = (result: RunResult) => void | Promise<void>;

export interface RunOptions {
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode?: SpawnPermissionMode;
  allowedTools?: string[];
  timeout?: number;
  maxTurns?: number;
  /** Current nesting depth (0 = top-level). Runtime increments on spawn. */
  depth?: number;
  /** Maximum allowed nesting depth. Spawn is rejected when depth >= maxDepth. */
  maxDepth?: number;
  builtin?: BuiltinOptions;
  onComplete?: OnCompleteCallback;
}

export interface RunTask extends Pick<RunOptions, "agentId" | "prompt" | "cwd" | "model" | "permissionMode" | "allowedTools" | "timeout" | "maxTurns"> {
  id: string;
  channelId: string;
  useThread?: boolean;
  showToolCalls?: boolean;
}
