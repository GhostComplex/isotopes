import type { RunEvent, RunOptions } from "./types.js";

export interface RunnerSignals {
  abort: AbortSignal;
}

export interface Runner {
  run(
    runId: string,
    options: RunOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<RunEvent>;
}
