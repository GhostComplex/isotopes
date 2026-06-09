import type { SendableChannels } from "discord.js";
import type { SessionEvent, SessionEventListener } from "../../gateway/index.js";
import { parseReply } from "../reply.js";

const DEFAULT_MIN_CHARS = 80;
const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_TIMEOUT_MS = 1500;
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export interface StreamBufferOptions {
  /** Don't even try to flush until the buffer has this many chars. */
  minChars?: number;
  /** Force a flush at this size even with no boundary — safety valve for boundary-less streams. */
  maxChars?: number;
  /** Force a flush this long after the last append if the buffer is still non-empty. */
  timeoutMs?: number;
}

// Send-new-message (not edit-in-place): edit would expose mid-stream truncated
// content. Tail-promise serializes appends so concurrent deltas stay ordered.
// Three flush triggers: (1) buffer ≥ minChars AND a boundary is found,
// (2) buffer ≥ maxChars (cap, even without boundary), (3) idle timeoutMs since
// the last append. Boundary search uses a paragraph > newline > sentence cascade
// covering both half- and full-width punctuation.
export class SegmentedStreamBuffer {
  private buffer = "";
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly timeoutMs: number;
  private readonly onFlush: (text: string) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onFlush: (text: string) => Promise<void>, options: StreamBufferOptions = {}) {
    this.onFlush = onFlush;
    this.minChars = options.minChars ?? DEFAULT_MIN_CHARS;
    this.maxChars = Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, this.minChars);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  append(text: string): Promise<void> {
    this.tail = this.tail.then(async () => {
      this.buffer += text;
      await this.tryFlush();
      this.scheduleTimeout();
    }).catch(() => {
      // Don't poison subsequent appends on a transient Discord error.
      this.buffer = "";
      this.clearFlushTimer();
    });
    return this.tail;
  }

  flushRemaining(): Promise<void> {
    this.tail = this.tail.then(async () => {
      this.clearFlushTimer();
      if (this.buffer.length === 0) return;
      const toFlush = this.buffer;
      this.buffer = "";
      await this.onFlush(toFlush);
    }).catch(() => { /* ignore */ });
    return this.tail;
  }

  private async tryFlush(): Promise<void> {
    if (this.buffer.length < this.minChars) return;
    const boundaryIndex = this.findBoundary();
    if (boundaryIndex !== -1) {
      const toFlush = this.buffer.slice(0, boundaryIndex);
      this.buffer = this.buffer.slice(boundaryIndex);
      await this.onFlush(toFlush);
      return;
    }
    if (this.buffer.length >= this.maxChars) {
      const toFlush = this.buffer.slice(0, this.maxChars);
      this.buffer = this.buffer.slice(this.maxChars);
      await this.onFlush(toFlush);
    }
  }

  /**
   * Pick the LATEST safe split point at or past minChars. Cascade matches
   * openclaw: paragraph > newline > sentence. Without the newline tier, single
   * `\n` in Markdown/lists never flushes; without the full-width tier, Chinese
   * `。！？` never flushes either.
   */
  private findBoundary(): number {
    const paragraph = this.findLastTokenEnd(["\n\n"]);
    if (paragraph !== -1) return paragraph;
    const newline = this.findLastTokenEnd(["\n"]);
    if (newline !== -1) return newline;
    return this.findSentenceBoundary();
  }

  private findLastTokenEnd(tokens: string[]): number {
    let best = -1;
    for (const token of tokens) {
      const idx = this.buffer.lastIndexOf(token);
      if (idx === -1) continue;
      const endPos = idx + token.length;
      if (endPos >= this.minChars && endPos > best) best = endPos;
    }
    return best;
  }

  /**
   * Half-width .!? needs trailing whitespace / end-of-buffer to avoid splitting
   * "U.S." or "e.g."; we consume the whitespace into the flushed segment so the
   * next chunk doesn't start with a stray space. Full-width 。！？； splits on
   * the punctuation alone — CJK text doesn't pad with spaces.
   */
  private findSentenceBoundary(): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const ch = this.buffer[i];
      if (ch === "." || ch === "!" || ch === "?") {
        const next = this.buffer[i + 1];
        if (next === undefined || next === " " || next === "\n" || next === "\t") {
          const split = next === undefined ? i + 1 : i + 2;
          if (split >= this.minChars) return split;
        }
      } else if (ch === "。" || ch === "！" || ch === "？" || ch === "；") {
        const split = i + 1;
        if (split >= this.minChars) return split;
      }
    }
    return -1;
  }

  private scheduleTimeout(): void {
    this.clearFlushTimer();
    if (this.buffer.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.tail = this.tail.then(async () => {
        if (this.buffer.length === 0) return;
        const toFlush = this.buffer;
        this.buffer = "";
        await this.onFlush(toFlush);
      }).catch(() => { /* ignore */ });
    }, this.timeoutMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
