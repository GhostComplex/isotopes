import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

/** Drive a pi-coding-agent session for one prompt and yield its events.
 * Caller owns session lifecycle (creation + dispose). */
export async function* streamPiSession(
  session: AgentSession,
  content: string,
  abort: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const onAbort = () => session.abort();
  abort.addEventListener("abort", onAbort, { once: true });
  if (abort.aborted) session.abort();

  type QueueItem = AgentEvent | { type: "__error__"; error: unknown };
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  const unsub = session.subscribe((event) => {
    queue.push(event as AgentEvent);
    if (resolve) { resolve(); resolve = null; }
  });

  session.prompt(content).catch((err) => {
    queue.push({ type: "__error__", error: err });
    if (resolve) { resolve(); resolve = null; }
  });

  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => { resolve = r; });
      }
      const item = queue.shift()!;
      if ((item as { type: string }).type === "__error__") {
        throw (item as { error: unknown }).error;
      }
      const e = item as AgentEvent;
      yield e;
      if (e.type === "agent_end") return;
    }
  } finally {
    unsub();
    abort.removeEventListener("abort", onAbort);
  }
}
