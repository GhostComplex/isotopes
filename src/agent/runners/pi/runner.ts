import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

function isAgentEvent(e: { type: string }): e is AgentEvent {
  return AGENT_EVENT_TYPES.has(e.type);
}

export class PiRunner {
  async *run(opts: {
    session: AgentSession;
    content: string;
    abort: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const { session, content, abort } = opts;

    const onAbort = () => session.abort();
    abort.addEventListener("abort", onAbort, { once: true });
    if (abort.aborted) session.abort();

    try {
      yield* streamSessionAgentEvents(session, content);
    } finally {
      abort.removeEventListener("abort", onAbort);
      session.dispose();
    }
  }
}

async function* streamSessionAgentEvents(
  session: AgentSession,
  content: string,
): AsyncGenerator<AgentEvent, void, void> {
  type QueueItem = AgentEvent | { type: "__error__"; error: unknown };
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    if (!isAgentEvent(event)) return;
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
  }
}
