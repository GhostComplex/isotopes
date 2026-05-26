import type { SendableChannels } from "discord.js";
import type { SessionEvent, SessionEventListener } from "../../gateway/index.js";
import { parseReply } from "../reply.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("discord");

const SENTENCE_BOUNDARIES = [". ", "! ", "? ", "\n\n"];
const DEFAULT_MAX_BUFFER_SIZE = 500;
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// Send-new-message (not edit-in-place): edit would expose mid-stream truncated
// content. Tail-promise serializes appends so concurrent deltas stay ordered.
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
    await this.onFlush(toFlush);
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

export interface DiscordSubscriber {
  onEvent: SessionEventListener;
  /** Resolves on agent_end after the final buffer flush completes. */
  done: Promise<void>;
}

interface OutboundContext {
  channel: SendableChannels;
  /** Trigger message id — used to resolve [[reply_to_current]]. */
  triggerMessageId: string;
  showToolCalls?: boolean;
}

export function createDiscordSubscriber(ctx: OutboundContext): DiscordSubscriber {
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
    const { stripped, replyToId } = parseReply(text, triggerMessageId);
    if (!stripped) return;
    if (stripped.trim() === "NO_REPLY") return; // silent-reply sentinel — see #803
    const chunks = chunkDiscordMessage(stripped);
    for (let i = 0; i < chunks.length; i++) {
      await sendChunk(chunks[i], replyToId, i === 0);
    }
  };

  const buffer = new SegmentedStreamBuffer(flushSegment);
  startTyping();

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const onEvent: SessionEventListener = (event: SessionEvent) => {
    if (event.type === "text_delta") {
      if (event.delta.length === 0) return;
      void buffer.append(event.delta);
    } else if (event.type === "tool_call" && showToolCalls) {
      void channel.send(`🔧 ${event.toolName}`).catch(() => {});
    } else if (event.type === "tool_result" && showToolCalls && event.isError) {
      void channel.send(`⚠️ ${event.toolName} failed`).catch(() => {});
    } else if (event.type === "agent_end") {
      void (async () => {
        try { await buffer.flushRemaining(); }
        finally { stopTyping(); resolveDone(); }
      })();
    }
  };

  return { onEvent, done };
}
