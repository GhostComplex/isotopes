// src/subagent/index.ts — Barrel exports and SubagentManager for sub-agent orchestration
// Provides the high-level API for spawning sub-agents and streaming output to Discord.

import { createLogger } from "../core/logger.js";
import { AcpxBackend } from "./acpx-backend.js";
import {
  DiscordSink,
  type SendMessageFn,
  type CreateThreadFn,
} from "./discord-sink.js";
import type {
  AcpxEvent,
  AcpxResult,
  DiscordSinkConfig,
  SubagentTask,
} from "./types.js";

const log = createLogger("subagent");

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  AcpxAgent,
  AcpxSpawnOptions,
  AcpxEventType,
  AcpxEvent,
  AcpxResult,
  DiscordSinkConfig,
  SubagentTask,
} from "./types.js";

export { ACPX_AGENTS } from "./types.js";

export { AcpxBackend, parseJsonLine, collectResult } from "./acpx-backend.js";
export type { AcpxBackendOptions } from "./acpx-backend.js";

export {
  DiscordSink,
  truncate,
  formatEvent,
  formatSummary,
} from "./discord-sink.js";
export type { SendMessageFn, CreateThreadFn } from "./discord-sink.js";

// ---------------------------------------------------------------------------
// SubagentManager
// ---------------------------------------------------------------------------

/**
 * High-level manager that coordinates sub-agent spawning with Discord output.
 *
 * Combines AcpxBackend (process management) with DiscordSink (output formatting)
 * to provide a single `spawn()` call that runs a sub-agent and streams results
 * to a Discord channel/thread.
 */
export class SubagentManager {
  constructor(
    private backend: AcpxBackend,
    private sendMessage: SendMessageFn,
    private createThread: CreateThreadFn,
  ) {}

  /**
   * Spawn a sub-agent task, streaming output to Discord.
   *
   * Creates a DiscordSink, starts the sub-agent via AcpxBackend,
   * and pipes all events through the sink for display.
   *
   * @param task - The sub-agent task to execute
   * @returns The final AcpxResult with all collected events
   */
  async spawn(task: SubagentTask): Promise<AcpxResult> {
    const sinkConfig: DiscordSinkConfig = {
      showToolCalls: task.showToolCalls ?? true,
      showThinking: false,
      useThread: task.useThread ?? true,
    };

    const sink = new DiscordSink(
      this.sendMessage,
      this.createThread,
      task.channelId,
      sinkConfig,
    );

    const taskLabel = `${task.agent}: ${task.prompt.slice(0, 50)}${task.prompt.length > 50 ? "..." : ""}`;

    log.info("Starting sub-agent task", { taskId: task.id, agent: task.agent });

    await sink.start(taskLabel);

    const events: AcpxEvent[] = [];

    try {
      for await (const event of this.backend.spawn(task.id, {
        agent: task.agent,
        prompt: task.prompt,
        cwd: task.cwd,
        model: task.model,
        approveAll: task.approveAll,
        permissionMode: task.permissionMode,
        allowedTools: task.allowedTools,
        timeout: task.timeout,
        maxTurns: task.maxTurns,
      })) {
        events.push(event);
        await sink.sendEvent(event);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Sub-agent task failed", { taskId: task.id, error: errorMsg });

      const errorEvent: AcpxEvent = { type: "error", error: errorMsg };
      events.push(errorEvent);
      await sink.sendEvent(errorEvent);
    }

    // Build result
    const doneEvent = events.find((e) => e.type === "done");
    const exitCode = doneEvent?.exitCode ?? 1;
    const hasError = events.some((e) => e.type === "error");

    const output = events
      .filter((e) => e.type === "message" && e.content)
      .map((e) => e.content!)
      .join("\n") || undefined;

    const error = events
      .filter((e) => e.type === "error" && e.error)
      .map((e) => e.error!)
      .join("\n") || undefined;

    const result: AcpxResult = {
      success: exitCode === 0 && !hasError,
      output,
      error,
      events,
      exitCode,
    };

    await sink.finish(result);

    log.info("Sub-agent task finished", {
      taskId: task.id,
      success: result.success,
      exitCode: result.exitCode,
    });

    return result;
  }

  /**
   * Cancel a running sub-agent task.
   *
   * @param taskId - The task to cancel
   * @returns true if the task was found and cancelled
   */
  cancel(taskId: string): boolean {
    return this.backend.cancel(taskId);
  }

  /**
   * Check if a sub-agent task is currently running.
   */
  isRunning(taskId: string): boolean {
    return this.backend.isRunning(taskId);
  }

  /**
   * Get the number of currently active sub-agent tasks.
   */
  get activeCount(): number {
    return this.backend.activeCount;
  }

  /**
   * Cancel all running sub-agent tasks.
   */
  cancelAll(): void {
    this.backend.cancelAll();
  }
}
