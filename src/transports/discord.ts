// src/transports/discord.ts — Discord transport for Isotopes
// Handles Discord bot connection, message routing, and response streaming.

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import {
  textContent,
  type AgentInstance,
  type AgentManager,
  type ChannelsConfig,
  type Message,
  type SessionStore,
  type ThreadBindingConfig,
  type Transport,
} from "../core/types.js";
import type { ContextConfigFile } from "../core/config.js";
import { shouldRespondToMessage } from "../core/mention.js";
import { loggers } from "../core/logger.js";
import { ThreadBindingManager } from "../core/thread-bindings.js";
import { runAgentLoop } from "../core/agent-runner.js";
import { isSilentReply } from "./silent-reply.js";
import { extractDiscordMetadata } from "./message-metadata.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import { buildSessionKey } from "../core/session-keys.js";
import {
  runWithSubagentContextAsync,
  type SubagentDiscordContext,
} from "../core/subagent-context.js";
import { preparePromptMessages } from "../core/context.js";
import { ChannelHistoryBuffer, buildHistoryContext } from "../core/channel-history.js";
import { DedupeCache } from "../core/dedupe.js";
import { InboundDebouncer } from "../core/debounce.js";
import { SlashCommandHandler } from "../commands/slash-commands.js";

const log = loggers.discord;

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

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
      await this.onFlush(this.buffer);
      this.buffer = "";
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

/** Configuration for the Discord transport. */
export interface DiscordTransportConfig {
  /** Discord bot token from Developer Portal */
  token: string;
  agentManager: AgentManager;
  sessionStore: SessionStore;
  sessionStoreForAgent?: (agentId: string) => SessionStore;
  /** Default agent ID to use when no @mention routing */
  defaultAgentId?: string;
  /** Map of Discord bot user ID → agent ID for multi-agent routing */
  agentBindings?: Record<string, string>;
  /** Whether to respond to DMs */
  allowDMs?: boolean;
  /** Channel IDs to listen to (empty = all) */
  channelAllowlist?: string[];
  /** Channels config for per-guild/group settings (e.g. requireMention) */
  channels?: ChannelsConfig;
  /** The account ID this bot is running as (for guild config lookup) */
  accountId?: string;
  /** Configuration for automatic thread-to-session binding */
  threadBindings?: ThreadBindingConfig;
  /** Thread binding manager instance (created automatically if not provided) */
  threadBindingManager?: ThreadBindingManager;
  /** Whether to enable subagent Discord streaming (default: true) */
  enableSubagentStreaming?: boolean;
  /** Whether to show tool calls in subagent threads (default: true) */
  subagentShowToolCalls?: boolean;
  /** Whether to respond to messages from other bots. Default: false */
  allowBots?: boolean;
  /** Context management configuration */
  context?: ContextConfigFile;
  /** Usage tracker for per-session/global token accumulation */
  usageTracker?: UsageTracker;
  /** Discord user IDs allowed to execute slash commands */
  adminUsers?: string[];
}

/**
 * DiscordTransport — connects agents to Discord.
 *
 * Features:
 * - @mention routing to specific agents
 * - Session per channel/thread
 * - Streaming responses with typing indicator
 * - Auto-chunking for long messages
 * - Subagent output streaming to threads
 */
export class DiscordTransport implements Transport {
  private client: Client;
  private config: DiscordTransportConfig;
  private ready = false;
  private threadBindingManager: ThreadBindingManager;
  private channelHistory: ChannelHistoryBuffer;
  private dedupe: DedupeCache;
  private debouncer: InboundDebouncer;
  private commandHandler: SlashCommandHandler;

  constructor(config: DiscordTransportConfig) {
    this.config = config;
    this.threadBindingManager = config.threadBindingManager ?? new ThreadBindingManager();
    this.channelHistory = new ChannelHistoryBuffer({
      maxEntriesPerChannel: config.context?.channelHistoryLimit ?? 20,
    });
    this.dedupe = new DedupeCache();
    this.debouncer = new InboundDebouncer({
      windowMs: config.context?.debounceWindowMs ?? 1500,
    });
    this.commandHandler = new SlashCommandHandler(config.adminUsers);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    this.client.on("ready", () => {
      log.info(`Logged in as ${this.client.user?.tag}`);
      this.ready = true;
    });

    this.client.on("messageCreate", (msg) => this.handleMessage(msg));

    // Register thread creation handler when thread bindings are enabled
    if (this.config.threadBindings?.enabled) {
      this.client.on("threadCreate", (thread) => this.handleThreadCreate(thread));
    }

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.debouncer.dispose();
    this.client.destroy();
    this.ready = false;
  }

  /** Access the thread binding manager (for external consumers / M3.2+) */
  getThreadBindingManager(): ThreadBindingManager {
    return this.threadBindingManager;
  }

  /** Access the Discord client (for subagent context) */
  getClient(): Client {
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Thread creation handling
  // ---------------------------------------------------------------------------

  private handleThreadCreate(thread: ThreadChannel): void {
    // Only handle guild threads with a parent channel
    if (!thread.parentId) {
      log.debug(`Ignoring thread ${thread.id} — no parent channel`);
      return;
    }

    // If there's a channel allowlist, only bind threads in allowed channels
    if (this.config.channelAllowlist?.length) {
      if (!this.config.channelAllowlist.includes(thread.parentId)) {
        log.debug(`Ignoring thread ${thread.id} — parent ${thread.parentId} not in allowlist`);
        return;
      }
    }

    const agentId = this.config.defaultAgentId ?? "default";

    log.info(`Thread created: ${thread.id} in channel ${thread.parentId}, binding to agent ${agentId}`);

    this.threadBindingManager.bind(thread.id, {
      parentChannelId: thread.parentId,
      agentId,
    });
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    // 1. Filter self and bot messages
    if (msg.author.id === this.client.user?.id) return;
    if (msg.author.bot && !this.config.allowBots) {
      log.debug(`Ignoring bot message from ${msg.author.username} (allowBots=false)`);
      return;
    }

    // 2. Deduplication — prevent processing the same message twice (gateway replays)
    const botId = this.client.user?.id ?? "unknown";
    if (this.config.context?.dedupe !== false && this.dedupe.isDuplicate(`${botId}:${msg.channelId}:${msg.id}`)) {
      log.debug(`Dedup: ignoring duplicate message ${msg.id}`);
      return;
    }

    // 3. Should-respond check — record to channel history if not responding
    const respond = this.shouldRespond(msg);
    if (!respond) {
      if (msg.guild && this.config.context?.channelHistory !== false) {
        const content = this.extractContent(msg);
        if (content.trim()) {
          this.channelHistory.append(msg.channelId, {
            sender: msg.author.username,
            body: content,
            timestamp: msg.createdTimestamp,
            messageId: msg.id,
          });
        }
      }
      return;
    }

    log.debug(`Received message from ${msg.author.username}: ${msg.content.substring(0, 50)}...`);

    // 4. Extract content
    let content = this.extractContent(msg);
    if (!content.trim()) return;

    // 4.5. Slash command interception — handle admin commands before agent dispatch
    if (this.commandHandler.isCommand(content)) {
      const agentId = this.resolveAgentId(msg);
      const sessionStore = this.getSessionStore(agentId);
      const sessionKey = this.getSessionKey(msg, agentId);
      const session = await sessionStore.findByKey(sessionKey);
      const agent = this.config.agentManager.get(agentId);

      const result = await this.commandHandler.execute(content, {
        agentManager: this.config.agentManager,
        sessionStore,
        agentId,
        userId: msg.author.id,
        username: msg.author.username,
        sessionId: session?.id,
        sessionKey,
        agentInstance: agent,
      });
      await (msg.channel as SendableChannel).send(result.response);
      return;
    }

    // 5. Debounce — combine rapid-fire messages from the same user (opt-in)
    if (this.config.context?.debounce) {
      const debounceKey = `discord:${msg.channelId}:${msg.author.id}`;
      const debounced = await this.debouncer.submit(
        debounceKey, content, msg.id, msg.createdTimestamp,
        { userId: msg.author.id, username: msg.author.username },
      );
      if (!debounced) return; // secondary caller — primary handles the combined message
      content = debounced.text;
    }

    // 6. Resolve agent
    const agentId = this.resolveAgentId(msg);
    log.debug(`Routing message to agent: ${agentId}`);

    const agent = this.config.agentManager.get(agentId);
    if (!agent) {
      log.warn(`Agent "${agentId}" not found`);
      return;
    }

    const sessionStore = this.getSessionStore(agentId);
    const sessionKey = this.getSessionKey(msg, agentId);
    const session = await this.findOrCreateSession(sessionStore, sessionKey, agentId, msg);

    // 7. Consume channel history and build enriched content
    const historyEntries = (this.config.context?.channelHistory !== false && msg.guild)
      ? this.channelHistory.consumeAndClear(msg.channelId)
      : [];
    const enrichedContent = buildHistoryContext(historyEntries, content);

    // 8. Add user message to session
    const messageMetadata = extractDiscordMetadata(msg);
    const userMessage: Message = {
      role: "user",
      content: textContent(enrichedContent),
      timestamp: msg.createdTimestamp,
      metadata: {
        userId: msg.author.id,
        username: msg.author.username,
        ...messageMetadata,
      },
    };
    await sessionStore.addMessage(session.id, userMessage);

    // 9. Prepare prompt — limitHistoryTurns + sanitize + prune
    const allMessages = await sessionStore.getMessages(session.id);
    const ctx = this.config.context;
    const promptInput = preparePromptMessages(allMessages, {
      historyTurns: ctx?.historyTurns ?? 20,
      protectRecentAssistant: ctx?.pruning?.protectRecent ?? 3,
      toolResultHeadChars: ctx?.pruning?.headChars ?? 1500,
      toolResultTailChars: ctx?.pruning?.tailChars ?? 1500,
    });

    log.debug(`Session ${session.id}: total=${allMessages.length}, sending=${promptInput.length}`);

    // 10. Clear agent internal state and run
    agent.clearMessages?.();
    await this.runAgentAndRespond(agent, promptInput, msg.channel as SendableChannel, session.id, sessionStore);
  }

  private shouldRespond(msg: DiscordMessage): boolean {
    // DM handling
    if (!msg.guild) {
      return this.config.allowDMs !== false;
    }

    // Channel allowlist
    if (this.config.channelAllowlist?.length) {
      if (!this.config.channelAllowlist.includes(msg.channelId)) {
        return false;
      }
    }

    // Check mention-based response using guild config
    const botId = this.client.user?.id;
    const isMentioned = botId ? msg.mentions.has(botId) : false;

    return shouldRespondToMessage(this.config.channels, {
      botUserId: botId ?? "",
      guildId: msg.guild.id,
      accountId: this.config.accountId,
      isMentioned,
      isDM: false,
    });
  }

  private resolveAgentId(msg: DiscordMessage): string {
    // Check if any mentioned user maps to an agent via bindings
    if (this.config.agentBindings) {
      for (const [botUserId, agentId] of Object.entries(this.config.agentBindings)) {
        if (msg.mentions.has(botUserId)) {
          return agentId;
        }
      }
    }

    // Fallback to default agent
    return this.config.defaultAgentId ?? "default";
  }

  private getSessionStore(agentId: string): SessionStore {
    return this.config.sessionStoreForAgent?.(agentId) ?? this.config.sessionStore;
  }

  private getSessionKey(msg: DiscordMessage, agentId: string): string {
    const botId = this.client.user?.id ?? "unknown";

    if (msg.thread) {
      return buildSessionKey("discord", botId, "thread", msg.thread.id, agentId);
    }
    if (!msg.guild) {
      return buildSessionKey("discord", botId, "dm", msg.author.id, agentId);
    }
    return buildSessionKey("discord", botId, "channel", msg.channelId, agentId);
  }

  private async findOrCreateSession(
    sessionStore: SessionStore,
    sessionKey: string,
    agentId: string,
    msg: DiscordMessage,
  ) {
    // Try to find existing session by key
    const existing = await sessionStore.findByKey(sessionKey);
    if (existing) {
      // Refresh channel/guild name on every message (handles renames)
      if (existing.metadata) {
        const channelName = "name" in msg.channel ? (msg.channel as { name?: string }).name : undefined;
        const guildName = msg.guild?.name;
        if (channelName) existing.metadata.channelName = channelName;
        if (guildName) existing.metadata.guildName = guildName;
      }
      return existing;
    }

    // Create new session with key
    const channelName = "name" in msg.channel ? (msg.channel as { name?: string }).name : undefined;
    const guildName = msg.guild?.name;
    const session = await sessionStore.create(agentId, {
      key: sessionKey,
      transport: "discord",
      channelId: msg.channelId,
      channelName: channelName ?? undefined,
      guildName: guildName ?? undefined,
      threadId: msg.thread?.id,
    });
    return session;
  }

  // ---------------------------------------------------------------------------
  // Subagent context helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a subagent Discord context for the given channel.
   * This context enables subagent tool to stream output to Discord threads.
   */
  private createSubagentContext(channel: SendableChannel): SubagentDiscordContext {
    const threadBindingConfig = this.config.threadBindings;
    const autoUnbindEnabled = threadBindingConfig?.autoUnbindOnComplete !== false;
    const sendFarewell = threadBindingConfig?.sendFarewell ?? false;
    const farewellMessage = threadBindingConfig?.farewellMessage ?? "Task completed. Returning to parent channel.";

    return {
      sendMessage: async (channelId: string, content: string) => {
        const targetChannel = await this.client.channels.fetch(channelId);
        if (!targetChannel || !("send" in targetChannel)) {
          throw new Error(`Cannot send message to channel ${channelId}`);
        }
        const msg = await (targetChannel as SendableChannel).send(content);
        return { id: msg.id };
      },
      createThread: async (channelId: string, name: string, messageId: string) => {
        const targetChannel = await this.client.channels.fetch(channelId);
        if (!targetChannel || !("threads" in targetChannel)) {
          throw new Error(`Cannot create thread in channel ${channelId}`);
        }
        const textChannel = targetChannel as TextChannel;
        const message = await textChannel.messages.fetch(messageId);
        const thread = await message.startThread({
          name,
          autoArchiveDuration: 60, // 1 hour
        });
        return { id: thread.id };
      },
      channelId: channel.id,
      showToolCalls: this.config.subagentShowToolCalls ?? true,
      onComplete: autoUnbindEnabled
        ? async (threadId: string) => {
            log.debug(`Subagent completed, auto-unbinding thread ${threadId}`);

            // Send farewell message if configured
            if (sendFarewell) {
              try {
                const thread = await this.client.channels.fetch(threadId);
                if (thread && "send" in thread) {
                  await (thread as SendableChannel).send(farewellMessage);
                }
              } catch (err) {
                log.warn("Failed to send farewell message", {
                  threadId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // Unbind the thread
            const removed = this.threadBindingManager.unbind(threadId, "subagent-complete");
            if (removed) {
              log.info(`Auto-unbound thread ${threadId} after subagent completion`);
            }
          }
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Agent interaction
  // ---------------------------------------------------------------------------

  private async runAgentAndRespond(
    agent: AgentInstance,
    input: string | Message[],
    channel: SendableChannel,
    sessionId: string,
    sessionStore: SessionStore,
  ): Promise<void> {
    // Start typing indicator
    const typing = this.startTyping(channel);

    try {
      // Track what we've already sent via the segmented buffer
      let lastSentLength = 0;

      // Create segmented stream buffer that sends new messages at sentence boundaries
      const streamBuffer = new SegmentedStreamBuffer(async (text: string) => {
        // Chunk if needed and send as new messages
        const chunks = this.chunkMessage(text);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      });

      // Create the agent loop runner function
      const runLoop = async () => {
        return runAgentLoop({
          agent,
          input,
          sessionId,
          sessionStore,
          log,
          onTextDelta: async (currentText) => {
            // Extract only the new delta text since last callback
            const delta = currentText.slice(lastSentLength);
            lastSentLength = currentText.length;

            if (delta.length > 0) {
              await streamBuffer.append(delta);
            }
          },
          usageTracker: this.config.usageTracker,
        });
      };

      // Run with or without subagent context based on config
      let errorMessage: string | null;
      let responseText: string;

      if (this.config.enableSubagentStreaming !== false) {
        // Run with subagent Discord context enabled
        const subagentContext = this.createSubagentContext(channel);
        const result = await runWithSubagentContextAsync(subagentContext, runLoop);

        errorMessage = result.errorMessage;
        responseText = result.responseText;
      } else {
        // Run without subagent context (original behavior)
        const result = await runLoop();

        errorMessage = result.errorMessage;
        responseText = result.responseText;
      }

      // Check for silent reply tokens — suppress outbound delivery
      if (isSilentReply(responseText)) {
        log.info(`Silent reply detected (${responseText.trim()}), suppressing Discord send`);
        typing.stop();
        return;
      }

      // Flush any remaining content in the buffer
      await streamBuffer.flushRemaining();

      if (errorMessage) {
        const finalErrorMessage = `❌ ${errorMessage}`;
        await sessionStore.addMessage(sessionId, {
          role: "assistant",
          content: textContent(finalErrorMessage),
          timestamp: Date.now(),
          metadata: { isError: true },
        });
        await channel.send(finalErrorMessage);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Agent error: ${errorMsg}`);
      try {
        await channel.send("❌ An error occurred while processing your request.");
      } catch (sendErr) {
        log.debug("Failed to send error message to Discord", sendErr);
      }
    } finally {
      typing.stop();
    }
  }

  private chunkMessage(content: string, maxLength = 2000): string[] {
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

      // Find a good break point
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

  private extractContent(msg: DiscordMessage): string {
    // Remove @mentions from content
    return msg.content
      .replace(/<@!?\d+>/g, "")
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Reply & reaction
  // ---------------------------------------------------------------------------

  async reply(messageId: string, content: string, channelId?: string): Promise<{ messageId: string }> {
    if (!this.ready) throw new Error("Discord transport not ready");

    // Fast path: fetch the channel directly when channelId is provided
    if (channelId) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && "messages" in channel) {
          const target = await (channel as SendableChannel).messages.fetch(messageId);
          const sent = await target.reply(content);
          return { messageId: sent.id };
        }
      } catch {
        // Fall through to slow path if channel fetch fails
      }
    }

    // Slow path: search all cached channels for the message
    const channels = this.client.channels.cache.values();
    for (const ch of channels) {
      if (!("messages" in ch)) continue;
      try {
        const target = await (ch as SendableChannel).messages.fetch(messageId);
        if (target) {
          const sent = await target.reply(content);
          return { messageId: sent.id };
        }
      } catch {
        // Message not in this channel, continue searching
      }
    }

    throw new Error(`Message not found: ${messageId}`);
  }

  async react(messageId: string, emoji: string, channelId?: string): Promise<void> {
    if (!this.ready) throw new Error("Discord transport not ready");

    // Fast path: fetch the channel directly when channelId is provided
    if (channelId) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && "messages" in channel) {
          const target = await (channel as SendableChannel).messages.fetch(messageId);
          await target.react(emoji);
          return;
        }
      } catch {
        // Fall through to slow path if channel fetch fails
      }
    }

    // Slow path: search all cached channels for the message
    const channels = this.client.channels.cache.values();
    for (const ch of channels) {
      if (!("messages" in ch)) continue;
      try {
        const target = await (ch as SendableChannel).messages.fetch(messageId);
        if (target) {
          await target.react(emoji);
          return;
        }
      } catch {
        // Message not in this channel, continue searching
      }
    }

    throw new Error(`Message not found: ${messageId}`);
  }

  private startTyping(channel: SendableChannel): { stop: () => void } {
    let active = true;

    const sendTyping = () => {
      if (active && "sendTyping" in channel) {
        channel.sendTyping().catch(() => {});
      }
    };

    // Send typing every 5 seconds
    sendTyping();
    const interval = setInterval(sendTyping, 5000);

    return {
      stop: () => {
        active = false;
        clearInterval(interval);
      },
    };
  }
}
