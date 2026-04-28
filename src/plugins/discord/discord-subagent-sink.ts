// src/plugins/discord/discord-subagent-sink.ts
//
// Streams a single sub-run's AgentEvent stream to a dedicated Discord
// thread. Used by the `send_message` tool when invoked from inside a
// Discord chat (DiscordSubagentStreamContext is set in AsyncLocalStorage).
//
// Lifecycle per sub-run:
//   1. start(label)  → creates the thread, posts a header, registers
//                      (threadId → runId) so /stop in the thread routes
//                      back to runtime.cancel(runId).
//   2. sendEvent(e)  → posts/edits messages in the thread for relevant
//                      AgentEvent types.
//   3. finish(result)→ posts a summary, unregisters the thread.

import { createLogger } from "../../core/logger.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { DiscordSubagentStreamContext } from "./subagent-stream-context.js";

const log = createLogger("discord-subagent-sink");

export interface DiscordSubagentSinkConfig {
  showToolCalls?: boolean;
}

export interface DiscordSubagentSinkSummary {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

const HEADER_PREFIX = "🤖";
const TOOL_PREFIX = "🔧";
const OK_PREFIX = "✅";
const FAIL_PREFIX = "❌";
const MAX_DISCORD_LEN = 1900; // leave headroom under Discord's 2000-char cap

function truncate(s: string, max = MAX_DISCORD_LEN): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export class DiscordSubagentSink {
  private threadId: string | undefined;
  private buffer = "";
  private toolCallNames = new Map<string, string>();
  private startedAt = 0;

  constructor(
    private readonly ctx: DiscordSubagentStreamContext,
    private readonly runId: string,
    private readonly config: DiscordSubagentSinkConfig = {},
  ) {}

  async start(taskLabel: string, headerMessageId?: string): Promise<string | undefined> {
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
      this.ctx.registerSubagentThread(thread.id, this.runId);
      log.debug("Sub-run thread opened", { runId: this.runId, threadId: thread.id });
      return thread.id;
    } catch (err) {
      log.warn("Failed to open sub-run thread; streaming disabled", {
        runId: this.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.threadId = undefined;
      return undefined;
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

  async finish(summary: DiscordSubagentSinkSummary): Promise<void> {
    await this.flushBuffer();
    if (!this.threadId) return;

    const seconds = (summary.durationMs / 1000).toFixed(1);
    const head = summary.success
      ? `${OK_PREFIX} done in ${seconds}s`
      : `${FAIL_PREFIX} failed in ${seconds}s`;
    const body = summary.success
      ? (summary.output ? `\n${truncate(summary.output, 1500)}` : "")
      : (summary.error ? `\n${truncate(summary.error, 1500)}` : "");
    try {
      await this.ctx.sendMessage(this.threadId, head + body);
    } catch (err) {
      log.warn("Failed to post summary", { runId: this.runId, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      this.ctx.unregisterSubagentThread(this.threadId);
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
    const chunks = chunkContent(content);
    for (const c of chunks) {
      try {
        await this.ctx.sendMessage(this.threadId, c);
      } catch (err) {
        log.warn("Failed to send message to sub-run thread", {
          runId: this.runId,
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

function chunkContent(content: string, maxLength = MAX_DISCORD_LEN): string[] {
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
