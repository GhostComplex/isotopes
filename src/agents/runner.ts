import type { RunnerKind, RunEvent, RunOptions } from "./types.js";

export interface RunnerSignals {
  abort: AbortSignal;
}

export interface Runner {
  readonly kind: RunnerKind;
  run(
    runId: string,
    options: RunOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<RunEvent>;
}
