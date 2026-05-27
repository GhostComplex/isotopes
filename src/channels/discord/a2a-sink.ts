import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  A2ASink,
  A2ASinkStartInfo,
  A2ASinkStartResult,
  A2ASinkSummary,
} from "../../agent/a2a-sink.js";
import { chunkDiscordMessage } from "./outbound.js";


const HEADER_PREFIX = "🤖";
const TOOL_PREFIX = "🔧";
const OK_PREFIX = "✅";
const FAIL_PREFIX = "❌";
const MAX_DISCORD_LEN = 1900;

/** Discord-specific deps the sink needs. Built per inbound by the channel adapter. */
export interface DiscordA2ASinkDeps {
  parentChannelId: string;
  showToolCalls?: boolean;
  sendMessage(channelId: string, content: string): Promise<{ id: string }>;
  createThread(parentChannelId: string, name: string, messageId: string): Promise<{ id: string }>;
  registerA2AThread(threadId: string, sessionId: string): void;
  unregisterA2AThread(threadId: string): void;
}

function truncate(s: string, max = MAX_DISCORD_LEN): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export class DiscordA2ASink implements A2ASink {
  private threadId: string | undefined;
  private sessionId: string | undefined;
  private buffer = "";
  private toolCallNames = new Map<string, string>();

  constructor(private readonly deps: DiscordA2ASinkDeps) {}

  async start(info: A2ASinkStartInfo): Promise<A2ASinkStartResult> {
    this.sessionId = info.sessionId;
    try {
      const headerMsg = await this.deps.sendMessage(
        this.deps.parentChannelId,
        `${HEADER_PREFIX} Starting: ${truncate(info.label, 200)}`,
      );
      const thread = await this.deps.createThread(
        this.deps.parentChannelId,
        truncate(info.label, 100),
        headerMsg.id,
      );
      this.threadId = thread.id;
      this.deps.registerA2AThread(thread.id, info.sessionId);
      return { status: "ok", surfaceId: thread.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.threadId = undefined;
      return { status: "error", error };
    }
  }

  async send(event: AgentEvent): Promise<void> {
    if (!this.threadId) return;

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta" && ame.delta) {
        this.buffer += ame.delta;
        if (this.buffer.length > 800 && (this.buffer.includes("\n\n") || this.buffer.includes(". "))) {
          await this.flushBuffer();
        }
      }
    } else if (event.type === "turn_end") {
      await this.flushBuffer();
    } else if (event.type === "tool_execution_start" && this.deps.showToolCalls) {
      this.toolCallNames.set(event.toolCallId, event.toolName);
      await this.sendToThread(`${TOOL_PREFIX} ${event.toolName}`);
    } else if (event.type === "tool_execution_end" && this.deps.showToolCalls) {
      const name = this.toolCallNames.get(event.toolCallId) ?? event.toolName;
      const status = event.isError ? FAIL_PREFIX : OK_PREFIX;
      const preview = typeof event.result === "string"
        ? truncate(event.result.split("\n")[0] ?? "", 200)
        : "";
      await this.sendToThread(`${status} ${name}${preview ? ` — ${preview}` : ""}`);
    } else if (event.type === "agent_end") {
      await this.flushBuffer();
    }
  }

  async finish(summary: A2ASinkSummary): Promise<void> {
    await this.flushBuffer();
    if (!this.threadId) return;

    const seconds = (summary.durationMs / 1000).toFixed(1);
    // Success: just the status line — assistant text already streamed via send(message_update).
    // Failure: append the error since it doesn't come through the message_update channel.
    const head = summary.success
      ? `${OK_PREFIX} done in ${seconds}s`
      : `${FAIL_PREFIX} failed in ${seconds}s`;
    const body = summary.success
      ? ""
      : (summary.error ? `\n${truncate(summary.error, 1500)}` : "");
    try {
      await this.deps.sendMessage(this.threadId, head + body);
    } catch {
      // TODO: add logging
    }
    try {
      this.deps.unregisterA2AThread(this.threadId);
    } catch { /* ignore */ }
  }

  private async flushBuffer(): Promise<void> {
    if (!this.threadId || this.buffer.length === 0) return;
    const text = this.buffer.trim();
    this.buffer = "";
    if (text.length === 0) return;
    await this.sendToThread(text);
  }

  private async sendToThread(content: string): Promise<void> {
    if (!this.threadId) return;
    const chunks = chunkDiscordMessage(content, MAX_DISCORD_LEN);
    for (const c of chunks) {
      try {
        await this.deps.sendMessage(this.threadId, c);
      } catch {
        return;
      }
    }
  }
}
