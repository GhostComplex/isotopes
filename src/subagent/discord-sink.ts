// src/subagent/discord-sink.ts — Format and send Claude CLI events to Discord
// Creates threads when configured, batches assistant text, and formats tool
// calls / thinking blocks for display.

import { createLogger } from "../core/logger.js";
import type { ClaudeEvent, ClaudeResult } from "./claude-runner.js";

const log = createLogger("subagent:discord-sink");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for how events are rendered into Discord. */
export interface DiscordSinkConfig {
  /** Show tool call names and inputs in Discord (default: true). */
  showToolCalls: boolean;
  /** Show thinking/reasoning blocks in Discord (default: false). */
  showThinking: boolean;
  /** Create a thread for the task output (default: true). */
  useThread: boolean;
}

/**
 * Minimal subset of a Discord.js text channel / thread.
 *
 * Using a structural interface instead of importing Discord.js types
 * so the module stays testable without the full Discord dependency.
 */
export interface DiscordChannel {
  id: string;
  send(options: { content: string }): Promise<{ id: string }>;
  /** Present on text channels; used to create threads. */
  threads?: {
    create(options: { name: string; autoArchiveDuration?: number }): Promise<DiscordChannel>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord message character limit. */
const MAX_MESSAGE_LENGTH = 2000;

/** Auto-archive threads after 1 hour. */
const THREAD_ARCHIVE_DURATION = 60;

// ---------------------------------------------------------------------------
// DiscordSink
// ---------------------------------------------------------------------------

/**
 * Sends Claude CLI streaming events to a Discord channel or thread.
 *
 * Lifecycle:
 *   1. `start(taskName)` — optionally creates a thread, posts a "started" message.
 *   2. `sendEvent(event)` — formats and posts each event.
 *   3. `finish(result)` — posts a summary with success/failure status.
 */
export class DiscordSink {
  private channel: DiscordChannel;
  private targetChannel: DiscordChannel | null = null;
  private config: DiscordSinkConfig;

  constructor(
    channel: DiscordChannel,
    config: Partial<DiscordSinkConfig> = {},
  ) {
    this.channel = channel;
    this.config = {
      showToolCalls: config.showToolCalls ?? true,
      showThinking: config.showThinking ?? false,
      useThread: config.useThread ?? true,
    };
  }

  /**
   * Start a new task sink.
   *
   * If `useThread` is enabled and the channel supports threads, creates a
   * new thread and returns its ID. Otherwise sends to the current channel.
   *
   * @returns The thread/channel ID where messages will be sent.
   */
  async start(taskName: string): Promise<string> {
    if (this.config.useThread && this.channel.threads) {
      try {
        const thread = await this.channel.threads.create({
          name: truncate(taskName, 100),
          autoArchiveDuration: THREAD_ARCHIVE_DURATION,
        });
        this.targetChannel = thread;
        log.info(`Created thread ${thread.id} for task "${taskName}"`);
      } catch (err) {
        log.warn(`Failed to create thread, falling back to channel: ${err}`);
        this.targetChannel = this.channel;
      }
    } else {
      this.targetChannel = this.channel;
    }

    await this.send(`**Task started:** ${truncate(taskName, 200)}`);
    return this.targetChannel.id;
  }

  /**
   * Send a single Claude event to Discord.
   *
   * Formatting depends on event type and sink configuration:
   * - `assistant_message` → plain text
   * - `tool_use` → code block (if showToolCalls)
   * - `tool_result` → truncated result (if showToolCalls)
   * - `thinking` → collapsed block (if showThinking)
   * - `error` → error message
   * - `done` → ignored (handled by finish())
   */
  async sendEvent(event: ClaudeEvent): Promise<void> {
    const message = formatEvent(event, this.config);
    if (message) {
      await this.send(message);
    }
  }

  /**
   * Post a completion summary.
   */
  async finish(result: ClaudeResult): Promise<void> {
    if (result.success) {
      const summary = result.output
        ? `**Task completed**\n${truncate(result.output, 1800)}`
        : "**Task completed** (no output)";
      await this.send(summary);
    } else {
      const errorMsg = result.error ?? "Unknown error";
      await this.send(`**Task failed:** ${truncate(errorMsg, 1900)}`);
    }
  }

  /**
   * Send a message to the target channel, splitting if necessary.
   */
  private async send(content: string): Promise<void> {
    if (!this.targetChannel) {
      log.warn("DiscordSink.send called before start()");
      return;
    }

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      try {
        await this.targetChannel.send({ content: chunk });
      } catch (err) {
        log.error(`Failed to send Discord message: ${err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a single event into a Discord-friendly string, or null to skip. */
function formatEvent(event: ClaudeEvent, config: DiscordSinkConfig): string | null {
  switch (event.type) {
    case "assistant_message":
      return event.content ? truncate(event.content, 1900) : null;

    case "tool_use":
      if (!config.showToolCalls) return null;
      return formatToolUse(event);

    case "tool_result":
      if (!config.showToolCalls) return null;
      return event.toolResult
        ? `**Tool result:**\n\`\`\`\n${truncate(event.toolResult, 1800)}\n\`\`\``
        : null;

    case "thinking":
      if (!config.showThinking) return null;
      return event.content
        ? `*Thinking:* ${truncate(event.content, 1900)}`
        : null;

    case "error":
      return event.error ? `**Error:** ${truncate(event.error, 1900)}` : null;

    case "done":
      // Handled by finish()
      return null;

    default:
      return null;
  }
}

/** Format a tool_use event with name and input. */
function formatToolUse(event: ClaudeEvent): string {
  const name = event.toolName ?? "unknown_tool";
  const input = event.toolInput
    ? truncate(JSON.stringify(event.toolInput, null, 2), 1700)
    : "{}";
  return `**Tool:** \`${name}\`\n\`\`\`json\n${input}\n\`\`\``;
}

/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/** Split a message into chunks that fit within Discord's character limit. */
function splitMessage(content: string): string[] {
  if (content.length <= MAX_MESSAGE_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split on a newline near the limit
    let splitIndex = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitIndex <= 0) {
      // No newline found — split at the limit
      splitIndex = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}
