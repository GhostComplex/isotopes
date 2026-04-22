// src/subagent/runners/builtin.ts — In-process subagent runner backed by PiMonoCore
// Reuses the parent agent's pi-mono core, provider config, and (filtered) tool
// registry — no separate API key, no separate SDK process.

import { randomUUID } from "node:crypto";
import { createLogger } from "../../core/logger.js";
import { PiMonoCore } from "../../core/pi-mono.js";
import { ToolRegistry, type ToolHandler } from "../../core/tools.js";
import { buildBuiltinSubagentSystemPrompt } from "../builtin/system-prompt.js";
import type { RunnerSignals, SubagentRunner } from "../runner.js";
import type { SubagentAgent, SubagentEvent, SubagentSpawnOptions } from "../types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const DENIED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "web_fetch",
  "web_search",
  "spawn_subagent",
]);

const log = createLogger("subagent:runner:builtin");

const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

function isAgentEvent(e: { type: string }): e is AgentEvent {
  return AGENT_EVENT_TYPES.has(e.type);
}

/**
 * Narrow shape over {@link PiMonoCore} that supports per-agent tool registries.
 * `PiMonoCore` satisfies this interface.
 */
export interface BuiltinPiMonoCore extends PiMonoCore {
  setToolRegistry(agentId: string, registry: ToolRegistry): void;
  clearToolRegistry(agentId: string): void;
}

/** Runner that runs a subagent in-process via the supplied PiMonoCore. */
export class BuiltinRunner implements SubagentRunner {
  readonly agent: SubagentAgent = "builtin";

  constructor(private readonly core: BuiltinPiMonoCore) {}

  async *run(
    taskId: string,
    options: SubagentSpawnOptions,
    signals: RunnerSignals,
  ): AsyncGenerator<SubagentEvent> {
    if (!options.builtin) {
      yield { type: "error", error: "builtin runner requires options.builtin" };
      yield { type: "done", exitCode: 1 };
      return;
    }

    const subagentId = `subagent-builtin-${taskId}-${randomUUID().slice(0, 8)}`;
    const tools = filterTools(options.builtin.tools, subagentId);
    const systemPrompt = buildBuiltinSubagentSystemPrompt({
      task: options.prompt,
      extraSystemPrompt: options.builtin.extraSystemPrompt,
    });

    log.info("BuiltinRunner.run", { taskId, subagentId, toolCount: tools.list().length });

    this.core.setToolRegistry(subagentId, tools);

    const cache = this.core.createServiceCache({
      id: subagentId,
      systemPrompt,
      provider: options.builtin.provider,
      compaction: { mode: "off" },
    });

    const sessionManager = SessionManager.inMemory();
    const session = await cache.createSession({
      sessionManager,
      systemPrompt,
    });

    const onAbort = () => session.abort();
    signals.abort.addEventListener("abort", onAbort, { once: true });
    if (signals.abort.aborted) session.abort();

    try {
      yield* bridgeSessionToSubagentEvents(session, options.prompt);
    } finally {
      signals.abort.removeEventListener("abort", onAbort);
      session.dispose();
      this.core.clearToolRegistry(subagentId);
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

async function* bridgeSessionToSubagentEvents(
  session: import("@mariozechner/pi-coding-agent").AgentSession,
  prompt: string,
): AsyncGenerator<SubagentEvent, void, void> {
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
        yield { type: "error", error: String((item as { error: unknown }).error) };
        yield { type: "done", exitCode: 1 };
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
          if (text.length > 0) yield { type: "message", content: text };
          buffer = "";
          break;
        }
        case "tool_execution_start":
          yield { type: "tool_use", toolName: e.toolName, toolInput: e.args };
          break;
        case "tool_execution_end": {
          const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
          yield { type: "tool_result", toolResult: output, ...(e.isError ? { error: "tool error" } : {}) };
          break;
        }
        case "agent_end": {
          const trailing = buffer.trim();
          if (trailing.length > 0) yield { type: "message", content: trailing };
          buffer = "";
          const lastAssistant = [...e.messages].reverse().find((m) => m.role === "assistant");
          const errMsg = (lastAssistant as unknown as { errorMessage?: string })?.errorMessage;
          if (errMsg) {
            yield { type: "error", error: errMsg };
            yield { type: "done", exitCode: 1 };
          } else {
            yield { type: "done", exitCode: 0 };
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
      if (trailing.length > 0) yield { type: "message", content: trailing };
      yield { type: "done", exitCode: 0 };
    }
  }
}
