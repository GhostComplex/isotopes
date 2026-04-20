// src/subagent/runners/builtin.ts — In-process subagent runner backed by AgentCore
// Reuses the parent agent's pi-mono core, provider config, and (filtered) tool
// registry — no separate API key, no separate SDK process.

import { randomUUID } from "node:crypto";
import { createLogger } from "../../core/logger.js";
import type { AgentCore } from "../../core/types.js";
import type { ToolRegistry } from "../../core/tools.js";
import { bridgeAgentEvents } from "../builtin/event-bridge.js";
import { buildBuiltinSubagentSystemPrompt } from "../builtin/system-prompt.js";
import { filterToolRegistry, resolveBuiltinToolPolicy } from "../builtin/tool-policy.js";
import type { RunnerSignals, SubagentRunner } from "../runner.js";
import type { SubagentAgent, SubagentEvent, SubagentSpawnOptions } from "../types.js";

const log = createLogger("subagent:runner:builtin");

/**
 * Narrow shape over {@link AgentCore} that supports per-agent tool registries.
 * `PiMonoCore` satisfies this interface.
 */
export interface BuiltinAgentCore extends AgentCore {
  setToolRegistry(agentId: string, registry: ToolRegistry): void;
  clearToolRegistry(agentId: string): void;
}

/** Runner that runs a subagent in-process via the supplied AgentCore. */
export class BuiltinRunner implements SubagentRunner {
  readonly agent: SubagentAgent = "builtin";

  constructor(private readonly core: BuiltinAgentCore) {}

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

    const role = options.builtin.role ?? "leaf";
    const policy = resolveBuiltinToolPolicy(role);
    const tools = filterToolRegistry(options.builtin.tools, policy);

    const subagentId = `subagent-builtin-${taskId}-${randomUUID().slice(0, 8)}`;
    const systemPrompt = buildBuiltinSubagentSystemPrompt({
      task: options.prompt,
      role,
      extraSystemPrompt: options.builtin.extraSystemPrompt,
    });

    log.info("BuiltinRunner.run", { taskId, subagentId, role, toolCount: tools.list().length });

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
