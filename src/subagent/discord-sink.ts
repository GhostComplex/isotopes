// src/subagent/discord-sink.ts — Stream sub-agent events to Discord
// Formats AcpxEvents and sends them to a Discord channel or thread.

import { createLogger } from "../core/logger.js";
import type { AcpxEvent, AcpxResult, DiscordSinkConfig } from "./types.js";

const log = createLogger("subagent:discord-sink");

// ---------------------------------------------------------------------------
// Types for Discord message sending
// ---------------------------------------------------------------------------

/** Function to send a message to a Discord channel/thread */
export type SendMessageFn = (
  channelId: string,
  content: string,
) => Promise<{ id: string }>;

/** Function to create a thread from a message */
export type CreateThreadFn = (
  channelId: string,
  name: string,
  messageId: string,
) => Promise<{ id: string }>;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Maximum Discord message length (leave headroom for formatting) */
const MAX_MESSAGE_LENGTH = 1900;

/**
 * Truncate content to fit Discord message limits.
 */
export function truncate(content: string, maxLen: number = MAX_MESSAGE_LENGTH): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen - 3) + "...";
}

/**
 * Format an AcpxEvent for display in Discord.
 *
 * Returns undefined if the event should not be displayed (e.g.,
 * tool calls when showToolCalls is false).
 */
export function formatEvent(event: AcpxEvent, config: DiscordSinkConfig): string | undefined {
  switch (event.type) {
    case "start":
      return undefined; // handled separately by DiscordSink.start()

    case "message":
      if (!event.content) return undefined;
      return truncate(event.content);

    case "tool_use":
      if (!config.showToolCalls) return undefined;
      return truncate(`🔧 **${event.toolName ?? "tool"}**`);

    case "tool_result":
      if (!config.showToolCalls) return undefined;
      return truncate(
        `📋 **${event.toolName ?? "tool"}** → \`\`\`\n${event.toolResult ?? "(no output)"}\n\`\`\``,
      );

    case "error":
      return truncate(`❌ ${event.error ?? "Unknown error"}`);

    case "done":
      return undefined; // handled separately by DiscordSink.finish()

    default:
      return undefined;
  }
}

/**
 * Format an AcpxResult summary for the completion message.
 *
 * @param result - The result to format
 * @param threadId - Optional thread ID to include as a link
 */
export function formatSummary(result: AcpxResult, threadId?: string): string {
  const status = result.success ? "✅ Completed" : "❌ Failed";
  const messageCount = result.events.filter((e) => e.type === "message").length;
  const toolCount = result.events.filter((e) => e.type === "tool_use").length;

  let summary = `${status} (exit code: ${result.exitCode})`;

  if (messageCount > 0 || toolCount > 0) {
    const parts: string[] = [];
    if (messageCount > 0) parts.push(`${messageCount} message${messageCount !== 1 ? "s" : ""}`);
    if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount !== 1 ? "s" : ""}`);
    summary += `\n${parts.join(", ")}`;
  }

  if (result.error) {
    summary += `\nError: ${truncate(result.error, 500)}`;
  }

  // Add thread link if available
  if (threadId) {
    summary += `\n📋 Details: <#${threadId}>`;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// DiscordSink
// ---------------------------------------------------------------------------

/**
 * Streams sub-agent events to a Discord channel.
 *
 * Optionally creates a thread for the output. Formats events according
 * to the DiscordSinkConfig (e.g., hiding tool calls).
 *
 * When `useThread` is enabled:
 * - Creates a thread for streaming message history
 * - Sends individual events to the thread
 * - Sends the final summary to the **main channel** (not the thread)
 */
export class DiscordSink {
  /** The channel where events are sent (thread if created, otherwise main channel) */
  private targetChannelId: string;
  /** The thread ID if one was created */
  private threadId?: string;
  /** The original main channel ID (for sending summary) */
  private mainChannelId: string;

  constructor(
    private sendMessage: SendMessageFn,
    private createThread: CreateThreadFn,
    private channelId: string,
    private config: DiscordSinkConfig,
  ) {
    this.targetChannelId = channelId;
    this.mainChannelId = channelId;
  }

  /**
   * Send an initial message and optionally create a thread.
   *
   * @param taskName - Display name for the task (used as thread name)
   */
  async start(taskName: string): Promise<void> {
    const content = `🤖 Starting sub-agent: **${truncate(taskName, 200)}**`;

    try {
      const msg = await this.sendMessage(this.channelId, content);

      if (this.config.useThread) {
        const threadName = truncate(taskName, 95); // Discord thread name limit
        const thread = await this.createThread(this.channelId, threadName, msg.id);
        this.threadId = thread.id;
        this.targetChannelId = thread.id;
        log.debug("Created thread for sub-agent output", { threadId: thread.id });
      }
    } catch (err) {
      log.error("Failed to send start message", err);
    }
  }

  /**
   * Send a formatted event to Discord.
   *
   * Events that produce no display content (per config) are skipped.
   */
  async sendEvent(event: AcpxEvent): Promise<void> {
    const content = formatEvent(event, this.config);
    if (!content) return;

    try {
      await this.sendMessage(this.targetChannelId, content);
    } catch (err) {
      log.error("Failed to send event to Discord", err);
    }
  }

  /**
   * Send a completion summary message to the main channel.
   *
   * When a thread was created, this sends the summary to the **main channel**
   * so users can see the result without opening the thread. When no thread
   * was used, it sends to the same channel where events were streamed.
   *
   * The summary includes a link to the thread if one was created.
   */
  async finish(result: AcpxResult): Promise<void> {
    // Include thread link in summary when a thread was created
    const content = formatSummary(result, this.threadId);

    try {
      // Always send the summary to the main channel, not the thread
      await this.sendMessage(this.mainChannelId, content);
    } catch (err) {
      log.error("Failed to send finish message", err);
    }
  }

  /**
   * Send a completion summary message to the thread (if created).
   *
   * Use this when you want to send the summary to the thread instead of
   * the main channel. If no thread was created, this is a no-op.
   */
  async finishInThread(result: AcpxResult): Promise<void> {
    if (!this.threadId) return;

    const content = formatSummary(result);

    try {
      await this.sendMessage(this.threadId, content);
    } catch (err) {
      log.error("Failed to send finish message to thread", err);
    }
  }

  /**
   * Get the thread ID if one was created, or undefined.
   */
  getThreadId(): string | undefined {
    return this.threadId;
  }

  /**
   * Get the channel ID that events are being sent to
   * (the thread if one was created, otherwise the original channel).
   */
  getTargetChannelId(): string {
    return this.targetChannelId;
  }

  /**
   * Get the main channel ID (where summaries are sent).
   */
  getMainChannelId(): string {
    return this.mainChannelId;
  }
}
