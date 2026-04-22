// src/subagent/runners/builtin.ts — In-process subagent runner backed by PiMonoCore
// Reuses the parent agent's pi-mono core, provider config, and (filtered) tool
// registry — no separate API key, no separate SDK process.

import { randomUUID } from "node:crypto";
import { createLogger } from "../../core/logger.js";
import { PiMonoCore } from "../../core/pi-mono.js";
import { ToolRegistry, type ToolHandler } from "../../core/tools.js";
import { bridgeAgentEvents } from "../builtin/event-bridge.js";
import { buildBuiltinSubagentSystemPrompt } from "../builtin/system-prompt.js";
import type { RunnerSignals, SubagentRunner } from "../runner.js";
import type { SubagentAgent, SubagentEvent, SubagentSpawnOptions } from "../types.js";

const DENIED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "web_fetch",
  "web_search",
  "spawn_subagent",
]);

const log = createLogger("subagent:runner:builtin");

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

    const instance = this.core.createAgent({
      id: subagentId,
      systemPrompt,
      provider: options.builtin.provider,
      compaction: { mode: "off" },
    });

    const onAbort = () => instance.abort();
    signals.abort.addEventListener("abort", onAbort, { once: true });
    if (signals.abort.aborted) instance.abort();

    try {
      yield* bridgeAgentEvents(instance.prompt(options.prompt));
    } finally {
      signals.abort.removeEventListener("abort", onAbort);
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
