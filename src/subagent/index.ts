// src/subagent/index.ts — Barrel exports for sub-agent subsystem

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  SubagentAgent,
  SubagentSpawnOptions,
  SubagentEventType,
  SubagentEvent,
  SubagentResult,
  SubagentTask,
} from "./types.js";

export { SubagentBackend, collectResult, summarizeEvents, MAX_CONCURRENT_AGENTS } from "./backend.js";
export { mapSdkMessage } from "./runners/claude.js";
export type { SubagentBackendOptions } from "./backend.js";

export type { SubagentStreamSink, SubagentStreamContext } from "../core/subagent-context.js";

export { TaskRegistry, taskRegistry } from "./task-registry.js";
export type { TaskInfo } from "./task-registry.js";

export { FailureTracker, failureTracker } from "./failure-tracker.js";
export type { BlockCheck } from "./failure-tracker.js";

