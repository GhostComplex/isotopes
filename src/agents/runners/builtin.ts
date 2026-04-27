import { randomUUID } from "node:crypto";
import { createLogger } from "../../core/logger.js";
import { PiMonoCore } from "../../core/pi-mono.js";
import { ToolRegistry, type ToolHandler } from "../../core/tools.js";
import { buildSpawnAgentSystemPrompt } from "../builtin/system-prompt.js";
import type { RunnerSignals, Runner } from "../runner.js";
import type { RunEvent, RunOptions } from "../types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const DENIED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "web_fetch",
  "web_search",
  "spawn_agent",
]);

const log = createLogger("agents:runner:builtin");

const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

function isAgentEvent(e: { type: string }): e is AgentEvent {
  return AGENT_EVENT_TYPES.has(e.type);
}

export class BuiltinRunner implements Runner {
  constructor(private readonly core: PiMonoCore) {}

  async *run(
    runId: string,
    options: RunOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<RunEvent> {
    if (!options.builtin) {
      yield { type: "run:error", error: "builtin runner requires options.builtin" };
      yield { type: "run:done", exitCode: 1 };
      return;
    }

    if (options.builtin.mode === "named") {
      yield* this.runNamed(runId, options, signals, options.builtin);
      return;
    }

    yield* this.runSubagent(runId, options, signals, options.builtin);
  }

  private async *runSubagent(
    runId: string,
    options: RunOptions,
    signals: RunnerSignals,
    builtin: Extract<NonNullable<RunOptions["builtin"]>, { mode: "subagent" }>,
  ): AsyncGenerator<RunEvent> {
    const agentId = `agent-builtin-${runId}-${randomUUID().slice(0, 8)}`;
    const tools = filterTools(builtin.tools, agentId);
    const systemPrompt = buildSpawnAgentSystemPrompt({
      task: options.prompt,
      extraSystemPrompt: builtin.extraSystemPrompt,
    });

    log.info("BuiltinRunner.run (subagent)", { runId, agentId, toolCount: tools.list().length });

    this.core.setToolRegistry(agentId, tools);

    // Compaction is intentionally OFF for subagent spawns: the system
    // prompt steers the agent toward terse single-shot tasks, there's no
    // SOUL/MEMORY identity worth preserving across compactions, and
    // compaction would add LLM-call overhead that defeats the
    // fire-and-forget premise. Long subagent runs that overflow context
    // will fail loudly — that's a signal the task should use a named
    // agent or Claude CLI instead. See issue #585 for making this opt-in.
    const cache = this.core.createServiceCache({
      id: agentId,
      provider: builtin.provider,
      compaction: { mode: "off" },
    });

    const sessionManager = builtin.sessionManager ?? SessionManager.inMemory();
    const session = await cache.createSession({
      sessionManager,
      systemPrompt,
    });

    const onAbort = () => session.abort();
    signals.abort.addEventListener("abort", onAbort, { once: true });
    if (signals.abort.aborted) session.abort();

    try {
      yield* bridgeSessionToRunEvents(session, options.prompt);
    } finally {
      signals.abort.removeEventListener("abort", onAbort);
      session.dispose();
      this.core.clearToolRegistry(agentId);
    }
  }

  private async *runNamed(
    runId: string,
    options: RunOptions,
    signals: RunnerSignals,
    builtin: Extract<NonNullable<RunOptions["builtin"]>, { mode: "named" }>,
  ): AsyncGenerator<RunEvent> {
    log.info("BuiltinRunner.run (named)", { runId, agentId: options.agentId });

    // Reuses the named agent's existing AgentServiceCache. The cache is
    // immutable after construction (model/authStorage/modelRegistry/
    // compactionConfig/customTools are set once), and `createSession`
    // builds a fresh settingsManager per call — so concurrent spawns of
    // the same named agent (or a spawn racing with direct user chat) are
    // session-isolated. Compaction and provider settings deliberately
    // inherit from the target agent's config (named = full identity);
    // do NOT force `compaction: { mode: "off" }` here as subagent does.
    const sessionManager = builtin.sessionManager ?? SessionManager.inMemory();
    const session = await builtin.cache.createSession({
      sessionManager,
      systemPrompt: builtin.systemPrompt,
    });

    const onAbort = () => session.abort();
    signals.abort.addEventListener("abort", onAbort, { once: true });
    if (signals.abort.aborted) session.abort();

    try {
      yield* bridgeSessionToRunEvents(session, options.prompt);
    } finally {
      signals.abort.removeEventListener("abort", onAbort);
      session.dispose();
    }
  }
}

function filterTools(parent: ToolRegistry, agentId: string): ToolRegistry {
  const filtered = new ToolRegistry(agentId);
  for (const tool of parent.list()) {
    if (DENIED_TOOLS.has(tool.name)) continue;
    const entry = parent.get(tool.name);
    if (!entry) continue;
    filtered.register(tool, entry.handler as ToolHandler);
  }
  return filtered;
}

async function* bridgeSessionToRunEvents(
  session: import("@mariozechner/pi-coding-agent").AgentSession,
  prompt: string,
): AsyncGenerator<RunEvent, void, void> {
  type QueueItem = AgentEvent | { type: "__done__" } | { type: "__error__"; error: unknown };
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    if (!isAgentEvent(event)) return;
    queue.push(event as AgentEvent);
    if (resolve) { resolve(); resolve = null; }
  });

  session.prompt(prompt).catch((err) => {
    queue.push({ type: "__error__", error: err });
    if (resolve) { resolve(); resolve = null; }
  });

  let buffer = "";
  let endedNormally = false;

  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => { resolve = r; });
      }

      const item = queue.shift()!;
      if (item.type === "__error__") {
        yield { type: "run:error", error: String((item as { error: unknown }).error) };
        yield { type: "run:done", exitCode: 1 };
        endedNormally = true;
        return;
      }
      if (item.type === "__done__") break;

      const e = item as AgentEvent;
      switch (e.type) {
        case "turn_start":
          buffer = "";
          break;
        case "message_update": {
          const ame = e.assistantMessageEvent;
          if (ame.type === "text_delta") buffer += ame.delta;
          break;
        }
        case "turn_end": {
          const text = buffer.trim();
          if (text.length > 0) yield { type: "run:message", content: text };
          buffer = "";
          break;
        }
        case "tool_execution_start":
          yield { type: "run:tool_use", toolName: e.toolName, toolInput: e.args };
          break;
        case "tool_execution_end": {
          const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
          yield { type: "run:tool_result", toolName: e.toolName ?? "unknown", toolResult: output, ...(e.isError ? { isError: true } : {}) };
          break;
        }
        case "agent_end": {
          const trailing = buffer.trim();
          if (trailing.length > 0) yield { type: "run:message", content: trailing };
          buffer = "";
          const lastAssistant = [...e.messages].reverse().find((m) => m.role === "assistant");
          const errMsg = (lastAssistant as unknown as { errorMessage?: string })?.errorMessage;
          if (errMsg) {
            yield { type: "run:error", error: errMsg };
            yield { type: "run:done", exitCode: 1 };
          } else {
            yield { type: "run:done", exitCode: 0 };
          }
          endedNormally = true;
          return;
        }
      }
    }
  } finally {
    unsub();
    if (!endedNormally) {
      const trailing = buffer.trim();
      if (trailing.length > 0) yield { type: "run:message", content: trailing };
      yield { type: "run:done", exitCode: 0 };
    }
  }
}
