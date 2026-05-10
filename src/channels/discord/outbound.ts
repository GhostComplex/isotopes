import type { SendableChannels } from "discord.js";
import type { DispatchCallbacks } from "../../gateway/index.js";
import { parseReplyDirective } from "./reply-directive.js";
import { loggers } from "../../logging/logger.js";
import type { ClientLike } from "./index.js";

const log = loggers.discord;

const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];
const DEFAULT_MAX_BUFFER_SIZE = 500;

// NEW messages (not edit) — edit-in-place would let other bots read truncated
// mid-edit content. Tail-promise serializes append/flushRemaining so concurrent
// deltas can't reorder Discord posts.
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
  /** Trigger message id — used to resolve [[reply_to_current]]. */
  triggerMessageId: string;
  showToolCalls?: boolean;
}

export function createDiscordCallbacks(ctx: OutboundContext): OutboundCallbacks {
  const { channel, triggerMessageId, showToolCalls = false } = ctx;

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

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/** Split into Discord-sendable chunks, preferring newline / space breaks. */
export function chunkDiscordMessage(content: string, maxLength = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (content.length <= maxLength) return [content];
  const out: string[] = [];
  let remaining = content;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.5) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

/**
 * Add a reaction. Tries channelId fast-path then scans the given clients'
 * caches. Caller decides which clients are eligible — pass a single-element
 * array to scope to one bot (per-agent binding).
 */
export async function reactToMessage(
  clients: ClientLike[],
  messageId: string,
  emoji: string,
  channelId?: string,
): Promise<void> {
  for (const client of clients) {
    if (channelId) {
      try {
        const channel = (await client.channels.fetch(channelId)) as
          | { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }
          | null;
        const target = await channel?.messages?.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch { /* try slow path */ }
    }

    for (const ch of client.channels.cache.values()) {
      const messages = (ch as { messages?: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }).messages;
      if (!messages) continue;
      try {
        const target = await messages.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch { /* not in this channel */ }
    }
  }
  throw new Error(`Message not found: ${messageId}`);
}
