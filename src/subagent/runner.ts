// src/subagent/runner.ts — Pluggable runner interface for subagent backends
// One runner per backend. The dispatcher (SubagentBackend) picks a runner
// based on options.agent and delegates the body of a run to it.

import type { SubagentAgent, SubagentEvent, SubagentSpawnOptions } from "./types.js";

/** Signals passed into a runner — currently just an abort handle. */
export interface RunnerSignals {
  /** Aborted by the dispatcher on cancel or timeout. */
  abort: AbortSignal;
}

/**
 * A runner executes a single subagent task.
 *
 * Conventions:
 * - The runner does NOT yield the leading "start" event — the dispatcher
 *   yields it before delegating.
 * - The runner SHOULD yield a terminal "done" event. The dispatcher provides
 *   a safety-net "done" if the runner exits without one.
 * - Cancellation is observed via `signals.abort`. The runner is responsible
 *   for translating an abort into a clean termination.
 */
export interface SubagentRunner {
  /** Backend identifier this runner serves. */
  readonly agent: SubagentAgent;
  /** Run the task, yielding events as they occur. */
  run(
    taskId: string,
    options: SubagentSpawnOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<SubagentEvent>;
}
