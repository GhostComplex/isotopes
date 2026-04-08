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
import type {
  AgentInstance,
  AgentManager,
  ChannelsConfig,
  Message,
  SessionStore,
  ThreadBindingConfig,
  Transport,
} from "../core/types.js";
import { textContent } from "../core/types.js";
import { shouldRespondToMessage } from "../core/mention.js";
import { loggers } from "../core/logger.js";
import { ThreadBindingManager } from "../core/thread-bindings.js";

const log = loggers.discord;

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

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
}

/**
 * DiscordTransport — connects agents to Discord.
 *
 * Features:
 * - @mention routing to specific agents
 * - Session per channel/thread
 * - Streaming responses with typing indicator
 * - Auto-chunking for long messages
 */
export class DiscordTransport implements Transport {
  private client: Client;
  private config: DiscordTransportConfig;
  private ready = false;
  private threadBindingManager: ThreadBindingManager;

  constructor(config: DiscordTransportConfig) {
    this.config = config;
    this.threadBindingManager = config.threadBindingManager ?? new ThreadBindingManager();
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
    this.client.destroy();
    this.ready = false;
  }

  /** Access the thread binding manager (for external consumers / M3.2+) */
  getThreadBindingManager(): ThreadBindingManager {
    return this.threadBindingManager;
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
    // Ignore bot messages
    if (msg.author.bot) return;

    // Check if we should respond
    if (!this.shouldRespond(msg)) return;

    log.debug(`Received message from ${msg.author.username}: ${msg.content.substring(0, 50)}...`);

    // Resolve agent
    const agentId = this.resolveAgentId(msg);
    log.debug(`Routing message to agent: ${agentId}`);

    const agent = this.config.agentManager.get(agentId);
    if (!agent) {
      log.warn(`Agent "${agentId}" not found`);
      return;
    }

    const sessionStore = this.getSessionStore(agentId);

    // Get or create session
    const sessionKey = this.getSessionKey(msg, agentId);
    const session = await this.findOrCreateSession(sessionStore, sessionKey, agentId, msg);

    // Extract message content (strip @mentions)
    const content = this.extractContent(msg);
    if (!content.trim()) return;

    // Add user message to session
    const userMessage: Message = {
      role: "user",
      content: textContent(content),
      timestamp: msg.createdTimestamp,
      metadata: {
        userId: msg.author.id,
        username: msg.author.username,
      },
    };
    await sessionStore.addMessage(session.id, userMessage);

    const promptInput = await sessionStore.getMessages(session.id);

    // Run agent and stream response
    await this.runAgentAndRespond(
      agent,
      promptInput,
      msg.channel as SendableChannel,
      session.id,
      sessionStore,
    );
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
      return `discord:${botId}:thread:${msg.thread.id}:${agentId}`;
    }
    if (!msg.guild) {
      return `discord:${botId}:dm:${msg.author.id}:${agentId}`;
    }
    return `discord:${botId}:channel:${msg.channelId}:${agentId}`;
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
      return existing;
    }

    // Create new session with key
    const session = await sessionStore.create(agentId, {
      key: sessionKey,
      transport: "discord",
      channelId: msg.channelId,
      threadId: msg.thread?.id,
    });
    return session;
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
      let responseText = "";
      let finalErrorMessage: string | null = null;
      let sentMessage: DiscordMessage | null = null;
      let lastUpdate = 0;

      for await (const event of agent.prompt(input)) {
        if (event.type === "text_delta") {
          responseText += event.text;

          // Update message periodically (rate limit: every 500ms)
          const now = Date.now();
          if (now - lastUpdate > 500 && responseText.length > 0) {
            sentMessage = await this.updateOrSendMessage(
              channel,
              sentMessage,
              responseText,
            );
            lastUpdate = now;
          }
        } else if (event.type === "agent_end") {
          // Store final assistant message
          if (responseText) {
            await sessionStore.addMessage(sessionId, {
              role: "assistant",
              content: textContent(responseText),
              timestamp: Date.now(),
            });
          }

          if (event.stopReason === "error") {
            const errorMsg = event.errorMessage ?? "Unknown agent error";
            log.error(`Agent ended with error: ${errorMsg}`);
            finalErrorMessage = `❌ ${errorMsg}`;
          }
        }
      }

      // Send final message
      if (responseText) {
        await this.updateOrSendMessage(channel, sentMessage, responseText);
      }
      if (finalErrorMessage) {
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
      } catch {
        // Ignore send failure
      }
    } finally {
      typing.stop();
    }
  }

  private async updateOrSendMessage(
    channel: SendableChannel,
    existing: DiscordMessage | null,
    content: string,
  ): Promise<DiscordMessage> {
    // Chunk if too long
    const chunks = this.chunkMessage(content);

    if (existing && chunks.length === 1) {
      // Update existing message
      await existing.edit(chunks[0]);
      return existing;
    }

    // Send new message(s)
    let lastMsg: DiscordMessage | null = null;
    for (const chunk of chunks) {
      if (existing && !lastMsg) {
        await existing.edit(chunk);
        lastMsg = existing;
      } else {
        lastMsg = await channel.send(chunk);
      }
    }
    return lastMsg!;
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
