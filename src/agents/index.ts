// src/agents/index.ts — Public surface of the agent layer.

export type {
  RunStatus,
  AgentSessionKind,
  RegisteredAgent,
  SendMessageRequest,
  RunInfo,
} from "./types.js";

export {
  AgentRuntime,
  LEAF_CONCURRENCY_CAP,
  LEAF_DEFAULT_TIMEOUT_SEC,
  RESERVED_AGENT_IDS,
} from "./runtime.js";
export type { AgentRuntimeOptions } from "./runtime.js";

export { FailureTracker, failureTracker } from "./failure-tracker.js";
export type { BlockCheck } from "./failure-tracker.js";
