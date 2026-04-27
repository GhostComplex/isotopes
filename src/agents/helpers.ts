import type { RunEvent, RunResult } from "./types.js";

export function summarizeEvents(events: RunEvent[]): RunResult {
  let lastExitCode = 0;
  let costUsd: number | undefined;

  for (const event of events) {
    if (event.type === "run:done") {
      lastExitCode = event.exitCode;
      if (event.costUsd !== undefined) costUsd = event.costUsd;
    }
  }

  const messages = events
    .filter((e): e is Extract<RunEvent, { type: "run:message" }> => e.type === "run:message")
    .map((e) => e.content)
    .join("\n");

  const errors = events
    .filter((e): e is Extract<RunEvent, { type: "run:error" }> => e.type === "run:error")
    .map((e) => e.error)
    .join("\n");

  return {
    success: lastExitCode === 0 && !errors,
    output: messages || undefined,
    error: errors || undefined,
    events,
    exitCode: lastExitCode,
    costUsd,
  };
}

export async function collectResult(
  events: AsyncGenerator<RunEvent>,
): Promise<RunResult> {
  const collected: RunEvent[] = [];
  for await (const event of events) collected.push(event);
  return summarizeEvents(collected);
}
