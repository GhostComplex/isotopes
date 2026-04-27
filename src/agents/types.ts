import type { ProviderConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tools.js";
import type { SubagentPermissionMode } from "../core/config.js";

export type RunStatus = "created" | "running" | "awaiting" | "completed" | "failed" | "cancelled";

export type RunnerKind = "in-process" | "external";

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

export interface InProcessOptions {
  provider: ProviderConfig;
  tools: ToolRegistry;
  extraSystemPrompt?: string;
}

export type OnCompleteCallback = (result: RunResult) => void | Promise<void>;

export interface RunOptions {
  runner: RunnerKind;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode?: SubagentPermissionMode;
  allowedTools?: string[];
  timeout?: number;
  maxTurns?: number;
  /** Current nesting depth (0 = top-level). Runtime increments on spawn. */
  depth?: number;
  /** Maximum allowed nesting depth. Spawn is rejected when depth >= maxDepth. */
  maxDepth?: number;
  inProcess?: InProcessOptions;
  onComplete?: OnCompleteCallback;
}

export interface RunTask extends Pick<RunOptions, "runner" | "prompt" | "cwd" | "model" | "permissionMode" | "allowedTools" | "timeout" | "maxTurns"> {
  id: string;
  channelId: string;
  useThread?: boolean;
  showToolCalls?: boolean;
}
