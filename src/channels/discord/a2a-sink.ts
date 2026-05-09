import { createLogger } from "../../logging/logger.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { DiscordA2AStreamContext } from "./a2a-stream-context.js";

const log = createLogger("discord-a2a-sink");

export interface DiscordA2ASinkConfig {
  showToolCalls?: boolean;
}

export interface DiscordA2ASinkSummary {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

const HEADER_PREFIX = "🤖";
const TOOL_PREFIX = "🔧";
const OK_PREFIX = "✅";
const FAIL_PREFIX = "❌";
const MAX_DISCORD_LEN = 1900;

function truncate(s: string, max = MAX_DISCORD_LEN): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export class DiscordA2ASink {
  private threadId: string | undefined;
  private buffer = "";
  private toolCallNames = new Map<string, string>();
  private startedAt = 0;

  constructor(
    private readonly ctx: DiscordA2AStreamContext,
    private readonly sessionId: string,
    private readonly config: DiscordA2ASinkConfig = {},
  ) {}

  async start(taskLabel: string, headerMessageId?: string): Promise<{ threadId?: string; error?: string }> {
    this.startedAt = Date.now();
    try {
      const headerMsg = headerMessageId
        ? { id: headerMessageId }
        : await this.ctx.sendMessage(this.ctx.parentChannelId, `${HEADER_PREFIX} Starting: ${truncate(taskLabel, 200)}`);
      const thread = await this.ctx.createThread(
        this.ctx.parentChannelId,
        truncate(taskLabel, 100),
        headerMsg.id,
      );
      this.threadId = thread.id;
      this.ctx.registerA2AThread(thread.id, this.sessionId);
      log.debug("Sub-run thread opened", { sessionId: this.sessionId, threadId: thread.id });
      return { threadId: thread.id };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn("Failed to open sub-run thread; streaming disabled", {
        sessionId: this.sessionId,
        error: errorMessage,
      });
      this.threadId = undefined;
      return { error: errorMessage };
    }
  }

  async sendEvent(event: AgentEvent): Promise<void> {
    if (!this.threadId) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta" && ame.delta) {
        this.buffer += ame.delta;
        // Soft-flush at paragraph boundaries to keep UX live without spamming.
        if (this.buffer.length > 800 && (this.buffer.includes("\n\n") || this.buffer.includes(". "))) {
          await this.flushBuffer();
        }
      }
    } else if (event.type === "turn_end") {
      await this.flushBuffer();
    } else if (event.type === "tool_execution_start" && this.config.showToolCalls) {
      this.toolCallNames.set(event.toolCallId, event.toolName);
      await this.send(`${TOOL_PREFIX} ${event.toolName}`);
    } else if (event.type === "tool_execution_end" && this.config.showToolCalls) {
      const name = this.toolCallNames.get(event.toolCallId) ?? event.toolName;
      const status = event.isError ? FAIL_PREFIX : OK_PREFIX;
      const preview = typeof event.result === "string"
        ? truncate(event.result.split("\n")[0] ?? "", 200)
        : "";
      await this.send(`${status} ${name}${preview ? ` — ${preview}` : ""}`);
    } else if (event.type === "agent_end") {
      await this.flushBuffer();
    }
  }

  async finish(summary: DiscordA2ASinkSummary): Promise<void> {
    await this.flushBuffer();
    if (!this.threadId) return;

    const seconds = (summary.durationMs / 1000).toFixed(1);
    // Success: just the status line — assistant text already streamed via
    // sendEvent(message_update). Failure: append the error since it doesn't
    // come through the message_update channel.
    const head = summary.success
      ? `${OK_PREFIX} done in ${seconds}s`
      : `${FAIL_PREFIX} failed in ${seconds}s`;
    const body = summary.success
      ? ""
      : (summary.error ? `\n${truncate(summary.error, 1500)}` : "");
    try {
      await this.ctx.sendMessage(this.threadId, head + body);
    } catch (err) {
      log.warn("Failed to post summary", { sessionId: this.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      this.ctx.unregisterA2AThread(this.threadId);
    } catch { /* ignore */ }
  }

  private async flushBuffer(): Promise<void> {
    if (!this.threadId || this.buffer.length === 0) return;
    const text = this.buffer.trim();
    this.buffer = "";
    if (text.length === 0) return;
    await this.send(text);
  }

  private async send(content: string): Promise<void> {
    if (!this.threadId) return;
    const chunks = chunkDiscordMessage(content, MAX_DISCORD_LEN);
    for (const c of chunks) {
      try {
        await this.ctx.sendMessage(this.threadId, c);
      } catch (err) {
        log.warn("Failed to send message to sub-run thread", {
          sessionId: this.sessionId,
          threadId: this.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
  }

  getThreadId(): string | undefined {
    return this.threadId;
  }
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
