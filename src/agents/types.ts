import type { ProviderConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tools.js";
import type { SpawnPermissionMode } from "../core/config.js";
import type { AgentServiceCache } from "../core/pi-mono.js";

export type RunStatus = "created" | "running" | "awaiting" | "completed" | "failed" | "cancelled";

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
 * - "ephemeral": fire-and-forget agent with no identity. Uses the parent's
 *   provider and a filtered subset of the parent's tools. The session is
 *   in-memory and discarded; the system prompt is the generic
 *   `buildSpawnAgentSystemPrompt()` preamble + task.
 *
 * - "named": spawn into an existing named agent's full identity. Uses the
 *   target agent's `AgentServiceCache` (which already owns its provider
 *   and tool registry) and the target's already-assembled system prompt
 *   (SOUL.md/MEMORY.md/TOOLS.md/tool guards merged at init time).
 */
export type BuiltinOptions =
  | {
      mode: "ephemeral";
      provider: ProviderConfig;
      tools: ToolRegistry;
      extraSystemPrompt?: string;
    }
  | {
      mode: "named";
      cache: AgentServiceCache;
      systemPrompt: string;
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
