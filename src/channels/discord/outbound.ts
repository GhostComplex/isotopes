// src/channels/discord/outbound.ts — Discord outbound streaming pipeline
//
// Builds the gateway DispatchCallbacks sink that delivers streamed agent text
// to a Discord channel. Buffers tokens at sentence boundaries and posts NEW
// messages (not message.edit) to avoid showing other bots truncated content
// in multi-agent scenarios.

import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import type { DispatchCallbacks } from "../../gateway/index.js";
import { parseReplyDirective } from "./reply-directive.js";

// ---------------------------------------------------------------------------
// SegmentedStreamBuffer — buffers streaming text and flushes at sentence boundaries
// ---------------------------------------------------------------------------

/** Sentence boundary patterns for flush detection */
const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];

/**
 * Buffers streaming text and flushes at sentence/paragraph boundaries.
 * This prevents message.edit() spam which causes other bots to see truncated content.
 */
export class SegmentedStreamBuffer {
  private buffer = "";
  private readonly maxBufferSize: number;
  private readonly onFlush: (text: string) => Promise<void>;

  /**
   * @param onFlush - Callback invoked when buffer is flushed (sends new message)
   * @param maxBufferSize - Max characters before forcing flush at next boundary (default 500)
   */
  constructor(onFlush: (text: string) => Promise<void>, maxBufferSize = 500) {
    this.onFlush = onFlush;
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Add text to the buffer. Will flush automatically at sentence boundaries
   * when buffer exceeds maxBufferSize.
   */
  async append(text: string): Promise<void> {
    this.buffer += text;
    await this.tryFlush();
  }

  /**
   * Flush all remaining content in the buffer.
   * Call this when streaming is complete.
   */
  async flushRemaining(): Promise<void> {
    if (this.buffer.length > 0) {
      const toFlush = this.buffer;
      this.buffer = "";
      await this.onFlush(toFlush);
    }
  }

  /**
   * Check if buffer should be flushed and do so if appropriate.
   * Flushes when buffer >= maxBufferSize AND a sentence boundary is found.
   */
  private async tryFlush(): Promise<void> {
    if (this.buffer.length < this.maxBufferSize) {
      return;
    }

    // Find the last sentence boundary in the buffer
    const boundaryIndex = this.findLastBoundary();
    if (boundaryIndex === -1) {
      // No boundary found yet, keep buffering
      return;
    }

    // Flush up to and including the boundary
    const toFlush = this.buffer.slice(0, boundaryIndex);
    this.buffer = this.buffer.slice(boundaryIndex);

    if (toFlush.length > 0) {
      await this.onFlush(toFlush);
    }
  }

  /**
   * Find the last sentence boundary position in the buffer.
   * Returns the index AFTER the boundary (i.e., where to split).
   */
  private findLastBoundary(): number {
    let lastIndex = -1;

    for (const boundary of SENTENCE_BOUNDARIES) {
      const idx = this.buffer.lastIndexOf(boundary);
      if (idx !== -1) {
        const endPos = idx + boundary.length;
        if (endPos > lastIndex) {
          lastIndex = endPos;
        }
      }
    }

    return lastIndex;
  }

  /** Get the current buffer content (for testing/debugging) */
  getBuffer(): string {
    return this.buffer;
  }
}

// ---------------------------------------------------------------------------
// Discord callbacks factory
// ---------------------------------------------------------------------------

/** Discord max message length. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/**
 * Split a string into Discord-sendable chunks (<= maxLength chars), preferring
 * newline / space break points to avoid mid-word splits.
 */
export function chunkDiscordMessage(content: string, maxLength = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf("\n", maxLength);
    if (breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }
    if (breakPoint < maxLength / 2) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * The DispatchCallbacks returned by `createDiscordCallbacks`, plus a
 * `flushRemaining` hook the caller invokes after `gateway.dispatch` resolves
 * to drain anything still sitting in the segmented buffer.
 */
export interface OutboundCallbacks extends DispatchCallbacks {
  /** Must be called after gateway.dispatch returns to flush any remaining buffered text. */
  flushRemaining(): Promise<void>;
}

/** Inputs needed to build a Discord-flavored outbound sink for one dispatch. */
export interface OutboundContext {
  /** Channel to post into (the channel the trigger arrived in, or a thread). */
  channel: SendableChannels;
  /** The message that triggered this run — used to satisfy [[reply_to_current]]. */
  triggerMessage: DiscordMessage;
  /** When true, post a small "tool used" status line per tool start. Default false. */
  showToolCalls?: boolean;
}

/**
 * Build a DispatchCallbacks suitable for `gateway.dispatch(msg, callbacks)`
 * that streams text into Discord using a SegmentedStreamBuffer and the
 * channel-agnostic reply-directive vocabulary.
 *
 * The caller MUST `await callbacks.flushRemaining()` after `gateway.dispatch`
 * resolves so any text still in the buffer is sent.
 */
export function createDiscordCallbacks(ctx: OutboundContext): OutboundCallbacks {
  const { channel, triggerMessage, showToolCalls = false } = ctx;
  const triggerMessageId = triggerMessage.id;

  const sendChunk = async (chunk: string, replyToId: string | undefined, isFirst: boolean): Promise<void> => {
    if (isFirst && replyToId) {
      // Use the trigger message as the reply target when the directive resolved
      // to the current message; for explicit ids use channel.send with a reply ref.
      if (replyToId === triggerMessageId) {
        await triggerMessage.reply({ content: chunk });
      } else {
        await channel.send({
          content: chunk,
          reply: { messageReference: replyToId, failIfNotExists: false },
        });
      }
    } else {
      await channel.send(chunk);
    }
  };

  const flushSegment = async (text: string): Promise<void> => {
    const { stripped, replyToId } = parseReplyDirective(text, triggerMessageId);
    if (!stripped) return; // segment was nothing but a directive
    const chunks = chunkDiscordMessage(stripped);
    for (let i = 0; i < chunks.length; i++) {
      await sendChunk(chunks[i], replyToId, i === 0);
    }
  };

  const buffer = new SegmentedStreamBuffer(flushSegment);

  // Tool start/end emit a tiny status line when enabled. Kept intentionally
  // minimal — richer rendering belongs to a future status-block feature.
  const onToolStart: DispatchCallbacks["onToolStart"] = showToolCalls
    ? (call) => {
        void channel.send(`🔧 ${call.name}`);
      }
    : undefined;

  const onToolEnd: DispatchCallbacks["onToolEnd"] = showToolCalls
    ? (result) => {
        if (result.isError) {
          void channel.send(`⚠️ ${result.name} failed`);
        }
      }
    : undefined;

  const callbacks: OutboundCallbacks = {
    onTextDelta: (delta) => {
      if (delta.length === 0) return;
      void buffer.append(delta);
    },
    flushRemaining: () => buffer.flushRemaining(),
  };

  if (onToolStart) callbacks.onToolStart = onToolStart;
  if (onToolEnd) callbacks.onToolEnd = onToolEnd;

  return callbacks;
}
