import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import type { DispatchCallbacks } from "../../gateway/index.js";
import { parseReplyDirective } from "./reply-directive.js";
import { chunkDiscordMessage } from "./a2a-sink.js";

const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];
const DEFAULT_MAX_BUFFER_SIZE = 500;

/**
 * Buffers streaming text and flushes at sentence/paragraph boundaries.
 * Sends NEW messages (not message.edit) so other bots in the channel never
 * read truncated mid-edit content — required for multi-agent safety.
 *
 * Calls to `append` and `flushRemaining` are serialized via an internal tail
 * promise so concurrent text deltas can't produce out-of-order Discord posts.
 */
export class SegmentedStreamBuffer {
  private buffer = "";
  private readonly maxBufferSize: number;
  private readonly onFlush: (text: string) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  constructor(onFlush: (text: string) => Promise<void>, maxBufferSize = DEFAULT_MAX_BUFFER_SIZE) {
    this.onFlush = onFlush;
    this.maxBufferSize = maxBufferSize;
  }

  append(text: string): Promise<void> {
    this.tail = this.tail.then(async () => {
      this.buffer += text;
      await this.tryFlush();
    });
    return this.tail;
  }

  flushRemaining(): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (this.buffer.length === 0) return;
      const toFlush = this.buffer;
      this.buffer = "";
      await this.onFlush(toFlush);
    });
    return this.tail;
  }

  private async tryFlush(): Promise<void> {
    if (this.buffer.length < this.maxBufferSize) return;
    const boundaryIndex = this.findLastBoundary();
    if (boundaryIndex === -1) return;
    const toFlush = this.buffer.slice(0, boundaryIndex);
    this.buffer = this.buffer.slice(boundaryIndex);
    if (toFlush.length > 0) await this.onFlush(toFlush);
  }

  private findLastBoundary(): number {
    let lastIndex = -1;
    for (const boundary of SENTENCE_BOUNDARIES) {
      const idx = this.buffer.lastIndexOf(boundary);
      if (idx !== -1) {
        const endPos = idx + boundary.length;
        if (endPos > lastIndex) lastIndex = endPos;
      }
    }
    return lastIndex;
  }

  getBuffer(): string {
    return this.buffer;
  }
}

export interface OutboundCallbacks extends DispatchCallbacks {
  /** Must be called after gateway.dispatch returns to drain the buffer. */
  flushRemaining(): Promise<void>;
}

export interface OutboundContext {
  channel: SendableChannels;
  /** Triggering message — used to satisfy [[reply_to_current]]. */
  triggerMessage: DiscordMessage;
  showToolCalls?: boolean;
}

/**
 * Build a DispatchCallbacks for `gateway.dispatch(msg, callbacks)` that
 * streams text into Discord. The caller MUST `await flushRemaining()` after
 * `gateway.dispatch` resolves.
 */
export function createDiscordCallbacks(ctx: OutboundContext): OutboundCallbacks {
  const { channel, triggerMessage, showToolCalls = false } = ctx;
  const triggerMessageId = triggerMessage.id;

  const sendChunk = async (chunk: string, replyToId: string | undefined, isFirst: boolean): Promise<void> => {
    if (!isFirst || !replyToId) {
      await channel.send(chunk);
      return;
    }
    if (replyToId === triggerMessageId) {
      await triggerMessage.reply({ content: chunk });
      return;
    }
    await channel.send({
      content: chunk,
      reply: { messageReference: replyToId, failIfNotExists: false },
    });
  };

  const flushSegment = async (text: string): Promise<void> => {
    const { stripped, replyToId } = parseReplyDirective(text, triggerMessageId);
    if (!stripped) return;
    const chunks = chunkDiscordMessage(stripped);
    for (let i = 0; i < chunks.length; i++) {
      await sendChunk(chunks[i], replyToId, i === 0);
    }
  };

  const buffer = new SegmentedStreamBuffer(flushSegment);

  const callbacks: OutboundCallbacks = {
    onTextDelta: (delta) => {
      if (delta.length === 0) return;
      void buffer.append(delta);
    },
    flushRemaining: () => buffer.flushRemaining(),
  };

  if (showToolCalls) {
    callbacks.onToolStart = async (call) => {
      try { await channel.send(`🔧 ${call.name}`); } catch { /* tolerate Discord errors */ }
    };
    callbacks.onToolEnd = async (result) => {
      if (!result.isError) return;
      try { await channel.send(`⚠️ ${result.name} failed`); } catch { /* tolerate Discord errors */ }
    };
  }

  return callbacks;
}
