import type { SendableChannels } from "discord.js";
import type { DispatchCallbacks } from "../../gateway/index.js";
import { parseReply } from "../reply.js";
import { SegmentedStreamBuffer } from "./stream-buffer.js";
import { chunkDiscordMessage } from "./message-chunk.js";

export interface OutboundCallbacks extends DispatchCallbacks {
  flushRemaining(): Promise<void>;
}

interface OutboundContext {
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
    const { stripped, replyToId } = parseReply(text, triggerMessageId);
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
