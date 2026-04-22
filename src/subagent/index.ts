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
  DiscordSinkConfig,
  SubagentTask,
} from "./types.js";

export { SUBAGENT_AGENTS } from "./types.js";

export { SubagentBackend, collectResult, summarizeEvents, mapSdkMessage, MAX_CONCURRENT_AGENTS } from "./backend.js";
export type { SubagentBackendOptions } from "./backend.js";

export {
  DiscordSink,
  truncate,
  formatEvent,
  formatSummary,
} from "../transports/discord-subagent-sink.js";
export type { SendMessageFn, CreateThreadFn } from "../transports/discord-subagent-sink.js";

export { TaskRegistry, taskRegistry } from "./task-registry.js";
export type { TaskInfo } from "./task-registry.js";

export { FailureTracker, failureTracker } from "./failure-tracker.js";
export type { BlockCheck } from "./failure-tracker.js";

