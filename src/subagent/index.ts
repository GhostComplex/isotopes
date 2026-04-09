// src/subagent/index.ts — Barrel exports for the subagent module
// Coordinates ClaudeRunner + DiscordSink to spawn Claude Code CLI as a
// subprocess and stream its output to Discord.

import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger.js";
import { ClaudeRunner } from "./claude-runner.js";
import { DiscordSink, type DiscordChannel } from "./discord-sink.js";

const log = createLogger("subagent");

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { ClaudeRunner } from "./claude-runner.js";
export type {
  ClaudeRunnerConfig,
  ClaudeTask,
  ClaudeEventType,
  ClaudeEvent,
  ClaudeResult,
} from "./claude-runner.js";

export { JsonStreamParser } from "./json-stream-parser.js";

export { DiscordSink } from "./discord-sink.js";
export type {
  DiscordSinkConfig,
  DiscordChannel,
} from "./discord-sink.js";

// ---------------------------------------------------------------------------
// SubagentManager
// ---------------------------------------------------------------------------

/** Options for spawning a subagent task. */
export interface SpawnOptions {
  /** The prompt to send to Claude. */
  prompt: string;
  /** Working directory for the Claude CLI process. */
  workdir: string;
  /** Discord channel to send output to. */
  channel: DiscordChannel;
  /** Create a thread for the task output (default: true). */
  useThread?: boolean;
  /** Show tool calls in Discord (default: true). */
  showToolCalls?: boolean;
  /** Show thinking/reasoning in Discord (default: false). */
  showThinking?: boolean;
  /** Timeout override in milliseconds. */
  timeout?: number;
}

/**
 * High-level coordinator for running Claude Code CLI tasks with Discord output.
 *
 * Combines {@link ClaudeRunner} for subprocess management with
 * {@link DiscordSink} for streaming events to Discord channels/threads.
 *
 * Usage:
 * ```ts
 * const manager = new SubagentManager(new ClaudeRunner());
 *
 * const result = await manager.spawn({
 *   prompt: "Fix the failing tests in src/",
 *   workdir: "/path/to/repo",
 *   channel: discordChannel,
 *   useThread: true,
 * });
 * ```
 */
export class SubagentManager {
  constructor(private runner: ClaudeRunner) {}

  /**
   * Spawn a Claude CLI task and stream its output to Discord.
   *
   * Creates a DiscordSink for the given channel, starts it (optionally
   * creating a thread), runs the Claude CLI task while forwarding events
   * to Discord, and posts a completion summary.
   *
   * @returns The aggregated result of the Claude CLI task.
   */
  async spawn(options: SpawnOptions) {
    const {
      prompt,
      workdir,
      channel,
      useThread = true,
      showToolCalls = true,
      showThinking = false,
      timeout,
    } = options;

    const taskId = randomUUID();

    log.info(`Spawning subagent task ${taskId}`);

    // Set up Discord sink
    const sink = new DiscordSink(channel, {
      showToolCalls,
      showThinking,
      useThread,
    });

    // Start sink (creates thread if configured)
    const taskName = prompt.length > 100
      ? prompt.substring(0, 97) + "..."
      : prompt;
    await sink.start(taskName);

    // Run Claude CLI with event forwarding
    const result = await this.runner.run({
      id: taskId,
      prompt,
      workdir,
      timeout,
      onEvent: (event) => {
        // Fire-and-forget to avoid blocking the stream parser
        sink.sendEvent(event).catch((err) => {
          log.error(`Failed to send event to Discord: ${err}`);
        });
      },
    });

    // Post completion summary
    await sink.finish(result);

    log.info(`Subagent task ${taskId} finished (success=${result.success})`);
    return result;
  }

  /**
   * Cancel a running subagent task.
   *
   * @returns `true` if the task was found and cancelled.
   */
  cancel(taskId: string): boolean {
    return this.runner.cancel(taskId);
  }

  /**
   * Check whether a task is currently running.
   */
  isRunning(taskId: string): boolean {
    return this.runner.isRunning(taskId);
  }
}
