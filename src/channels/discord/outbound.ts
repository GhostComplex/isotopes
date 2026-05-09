import type { Message as DiscordMessage, SendableChannels } from "discord.js";
import type { DispatchCallbacks } from "../../gateway/index.js";
import { parseReplyDirective } from "./reply-directive.js";
import { chunkDiscordMessage } from "./a2a-sink.js";
import { loggers } from "../../logging/logger.js";

const log = loggers.discord;

const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];
const DEFAULT_MAX_BUFFER_SIZE = 500;

/**
 * Buffers streaming text and flushes at sentence boundaries via NEW messages
 * (not message.edit). Edit-in-place would let other bots in the channel read
 * truncated mid-edit content — a real footgun in multi-agent setups.
 *
 * append/flushRemaining serialize via a tail promise so concurrent text
 * deltas can't interleave into out-of-order Discord posts.
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
    }).catch((err) => {
      // Don't poison subsequent appends on a transient Discord error.
      this.buffer = "";
      log.warn(`SegmentedStreamBuffer flush failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.tail;
  }

  flushRemaining(): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (this.buffer.length === 0) return;
      const toFlush = this.buffer;
      this.buffer = "";
      await this.onFlush(toFlush);
    }).catch((err) => {
      log.warn(`SegmentedStreamBuffer final flush failed: ${err instanceof Error ? err.message : String(err)}`);
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
  flushRemaining(): Promise<void>;
}

export interface OutboundContext {
  channel: SendableChannels;
  /** Triggering message — used to satisfy [[reply_to_current]]. */
  triggerMessage: DiscordMessage;
  showToolCalls?: boolean;
}

export function createDiscordCallbacks(ctx: OutboundContext): OutboundCallbacks {
  const { channel, triggerMessage, showToolCalls = false } = ctx;
  const triggerMessageId = triggerMessage.id;

  // Discord's typing indicator lasts ~10s; refresh every 7s while active.
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  const startTyping = (): void => {
    if (typingTimer || !("sendTyping" in channel)) return;
    const ping = () => { void channel.sendTyping().catch(() => {}); };
    ping();
    typingTimer = setInterval(ping, 7000);
  };
  const stopTyping = (): void => {
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  };

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
  startTyping();

  const callbacks: OutboundCallbacks = {
    onTextDelta: (delta) => {
      if (delta.length === 0) return;
      void buffer.append(delta);
    },
    flushRemaining: async () => {
      try {
        await buffer.flushRemaining();
      } finally {
        stopTyping();
      }
    },
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
