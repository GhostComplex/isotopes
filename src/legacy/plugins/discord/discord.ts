// src/plugins/discord/discord.ts — Discord transport for Isotopes
// Handles Discord bot connection, message routing, and response streaming.

import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionStore } from "../../../sessions/types.js";
import type { Transport } from "../../../legacy/gateway/types.js";
import type { ThreadBindingConfig } from "./types.js";
import { resolveAgentWorkspacePath } from "../../../paths.js";
import { userMessage as mkUserMsg, userMessageWithImages as mkUserMsgWithImages } from "../../../agent/runners/pi/messages.js";
import type { ContextConfigFile } from "../../../config.js";
import { shouldRespondToMessage } from "../../../legacy/gateway/mention.js";
import { loggers } from "../../../logging/logger.js";
import { ThreadBindingManager } from "./thread-bindings.js";
import { runAgent } from "../../../agent/runtime-adapter.js";
import { runWithDiscordA2AStream, type DiscordA2AStreamContext } from "./a2a-stream-context.js";
import { isSilentReplyPayloadText } from "../../../silent-reply.js";
import { extractDiscordMetadata, formatInboundMeta } from "./message-metadata.js";
import { parseReplyDirective, REPLY_DIRECTIVE_PROMPT } from "../../../legacy/gateway/reply-directive.js";
import { buildSessionKey } from "../../../legacy/gateway/session-keys.js";
import { ChannelHistoryBuffer, buildHistoryContext } from "../../../legacy/gateway/channel-history.js";
import { DedupeCache } from "../../../legacy/gateway/dedupe.js";
import { InboundDebouncer } from "../../../legacy/gateway/debounce.js";
import { SlashCommandHandler } from "../../../legacy/gateway/commands.js";

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
  /**
   * Unified runtime. When provided, the transport drives the agent loop via
   * `runtime.run` (the #568 path). When omitted, falls back to the
   * legacy `runAgentLoop` (kept temporarily for unit tests that pre-date the
   * runtime; will be removed once those tests are migrated).
   */
  agentRuntime?: import("../../../agent/runtime.js").AgentRuntime;
  sessionStore: SessionStore;
  sessionStoreForAgent?: (agentId: string) => SessionStore;
  /** Default agent ID to use when no @mention routing */
  defaultAgentId?: string;
  /** Map of Discord bot user ID → agent ID for multi-agent routing */
  agentBindings?: Record<string, string>;
  /** DM access control policy. */
  dmAccess?: {
    policy?: "disabled" | "allowlist";
    allowlist?: string[];
  };
  /** Group (guild) access control — parallel to `dmAccess`. Default policy is `"allowlist"`. */
  groupAccess?: {
    policy?: "disabled" | "allowlist" | "open";
    channelAllowlist?: string[];
    guildAllowlist?: string[];
  };
  /** Per-guild settings (e.g. requireMention) */
  guilds?: Record<string, import("./types.js").GuildConfig>;
  /** Configuration for automatic thread-to-session binding */
  threadBindings?: ThreadBindingConfig;
  /** Thread binding manager instance (created automatically if not provided) */
  threadBindingManager?: ThreadBindingManager;
  /** Whether to show tool call info in agent responses (default: false) */
  showToolCalls?: boolean;
  /** Whether to respond to messages from other bots. Default: false */
  allowBots?: boolean;
  /** Context management configuration */
  context?: ContextConfigFile;
  /** Usage tracker for per-session/global token accumulation */
  /** Discord user IDs allowed to execute slash commands */
  adminUsers?: string[];
  /** Thread control configuration — whether to respond/observe in threads */
  threads?: {
    /** Whether to respond to messages in threads. Default: true */
    respond?: boolean;
    /** Whether to include thread messages in channel history context. Default: true */
    observe?: boolean;
  };
}

/**
 * DiscordTransport — connects agents to Discord.
 *
 * Features:
 * - @mention routing to specific agents
 * - Session per channel/thread
 * - Streaming responses with typing indicator
 * - Auto-chunking for long messages
 * - Spawn agent output streaming to threads
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

  // Maps a Discord thread id (created for a sub-run via spawn_agent) to
  // the sub-run's sessionId so /stop in that thread cancels the right run.
  private a2aThreads = new Map<string, string>();

  // Buffer messages that arrive while a session is prompting
  private pendingMessages = new Map<string, Array<{ content: string; sender: string; timestamp: number }>>();

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
      partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
    });
  }

  async start(): Promise<void> {
    this.client.on("clientReady", () => {
      log.info(`Logged in as ${this.client.user?.tag}`);
      this.ready = true;
    });

    this.client.on("error", (err) => {
      log.error(`Discord client error: ${err.message}`);
    });

    // discord.js v14 doesn't reliably emit messageCreate for DMs even with
    // Partials.Channel. Intercept raw gateway packets and manually fetch the
    // Message object for DM MESSAGE_CREATE events.
    this.client.on("raw", async (packet: { t: string; d: unknown }) => {
      if (packet.t !== "MESSAGE_CREATE") return;
      const data = packet.d as Record<string, unknown>;
      if (data.guild_id) return;

      const channelId = data.channel_id as string;
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased()) return;
        const message = await channel.messages.fetch(data.id as string);
        await this.handleMessage(message);
      } catch (err) {
        log.warn("Failed to fetch DM message", {
          channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

  /** Access the Discord client (for spawn agent context) */
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

    // If a channel allowlist is configured, only bind threads in allowed channels.
    const group = this.resolveGroup();
    if (group.policy === "disabled") {
      log.debug(`Ignoring thread ${thread.id} — group policy disabled`);
      return;
    }
    if (group.policy === "allowlist") {
      const channelOk = group.channelAllowlist?.includes(thread.parentId) ?? false;
      const guildOk = group.guildAllowlist?.includes(thread.guildId) ?? false;
      if (!channelOk && !guildOk) {
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
      log.debug(`discord: drop bot message (allowBots=false) from ${msg.author.username}`);
      return;
    }

    const botId = this.client.user!.id;
    const isMentioned = msg.mentions.has(botId);
    const inboundType = msg.channel.isThread() ? "thread" : msg.guild ? "guild" : "dm";
    log.debug(
      `discord: inbound id=${msg.id} guild=${msg.guild?.id ?? "dm"} channel=${msg.channelId} ` +
      `mention=${isMentioned ? "yes" : "no"} type=${inboundType} len=${msg.content.length}`,
    );

    // 2. Deduplication — prevent processing the same message twice (gateway replays)
    const dedupeKey = `${botId}:${msg.channelId}:${msg.id}`;
    if (this.config.context?.dedupe !== false && this.dedupe.isDuplicate(dedupeKey)) {
      log.debug(`Dedup: ignoring duplicate message ${msg.id}`);
      return;
    }

    // 2.5. Thread control — skip thread messages based on threads.respond/observe config
    const isThread = msg.channel.isThread();
    const threadsRespond = this.config.threads?.respond ?? true;
    const threadsObserve = this.config.threads?.observe ?? true;

    if (isThread && !threadsRespond && !threadsObserve) {
      // Both disabled — completely ignore thread messages
      log.debug(`Thread message ignored (threads.respond=false, threads.observe=false)`);
      return;
    }

    // 3. Extract content early for spawn agent thread interception
    let content = this.extractContent(msg);
    if (!content.trim() && !this.hasImageAttachments(msg)) return;

    // 3.6. Main-agent /stop or /cancel — abort current run if any.
    // Runs before shouldRespond so it works without channel-config gating, but in
    // group channels we still require @mention so a shared /stop in a multi-bot
    // channel only aborts the addressed bot's session. DMs are 1:1 so no mention
    // is required there. Allows an optional leading @mention token in the raw
    // content since extractContent only strips numeric Discord ids.
    const stopMatch = /^(?:<@!?\S+>\s*)?\/(stop|cancel)\s*$/i.exec(msg.content.trim());
    if (stopMatch) {
      // 3.6a. /stop in a known sub-run thread → cancel by sessionId.
      // No @mention required: posting in the thread itself scopes the intent.
      if (isThread) {
        const subSessionId = this.a2aThreads.get(msg.channelId);
        if (subSessionId && this.config.agentRuntime) {
          const cancelled = this.config.agentRuntime.cancel(subSessionId, { reason: "user" });
          if (cancelled) {
            log.info(`Sub-run /stop`, { sessionId: subSessionId, threadId: msg.channelId });
            await (msg.channel as SendableChannel).send("🛑 Sub-run cancelled.");
          } else {
            await (msg.channel as SendableChannel).send("⚠️ Sub-run already finished.");
          }
          return;
        }
      }

      const botId = this.client.user?.id;
      const isMentioned = botId ? msg.mentions.has(botId) : false;
      if (msg.guild && !isMentioned) {
        return; // group channel without @mention — not for this bot
      }
      const agentId = this.resolveAgentId(msg);
      const sessionStore = this.getSessionStore(agentId);
      const sessionKey = this.getSessionKey(msg);
      const session = await sessionStore.findByKey(sessionKey);
      const runtimeForCheck = this.config.agentRuntime;
      const isActive = runtimeForCheck && session
        ? runtimeForCheck.isRunning(session.id)
        : false;
      if (session && isActive && runtimeForCheck) {
        log.info(`Main-agent /stop`, { sessionId: session.id, agentId });
        runtimeForCheck.cancel(session.id);
        this.pendingMessages.delete(session.id);
        await (msg.channel as SendableChannel).send("🛑 Stopped.");
        return;
      }
      return;
    }

    // 4. Should-respond check — record to channel history if not responding
    const respond = this.shouldRespond(msg);

    // Thread-specific control: if threads.respond=false, don't respond in threads
    // but still may observe (record to history) if threads.observe=true
    if (isThread && !threadsRespond) {
      // threads.respond=false — don't respond, but may observe
      if (threadsObserve && msg.guild && this.config.context?.channelHistory !== false) {
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
      log.debug(`Thread message not responded (threads.respond=false, observe=${threadsObserve})`);
      return;
    }

    if (!respond) {
      // Not a thread case, or threads.respond=true but shouldRespond=false
      // Only observe if threads.observe allows (for threads) or standard observe for non-threads
      const shouldObserve = isThread ? threadsObserve : true;
      if (shouldObserve && msg.guild && this.config.context?.channelHistory !== false) {
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

    // 5. Slash command interception — handle admin commands before agent dispatch
    if (this.commandHandler.isCommand(content)) {
      const agentId = this.resolveAgentId(msg);
      const sessionStore = this.getSessionStore(agentId);
      const sessionKey = this.getSessionKey(msg);
      const session = await sessionStore.findByKey(sessionKey);

      if (!this.config.agentRuntime) {
        await (msg.channel as SendableChannel).send("⚠️ Slash commands require AgentRuntime — not configured.");
        return;
      }
      const result = await this.commandHandler.execute(content, {
        agentRuntime: this.config.agentRuntime,
        sessionStore,
        agentId,
        userId: msg.author.id,
        username: msg.author.username,
        sessionId: session?.id,
        sessionKey,
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

    if (!this.config.agentRuntime?.getAgent(agentId)) {
      log.warn(`Agent "${agentId}" not found`);
      return;
    }

    const sessionStore = this.getSessionStore(agentId);
    const sessionKey = this.getSessionKey(msg);
    const session = await this.findOrCreateSession(sessionStore, sessionKey, agentId, msg);

    // 6.5. If session is currently active (in a prompt turn), buffer this message instead.
    // The buffer is drained at turn_end via onTurnEnd, where each message is
    // also persisted to SessionStore so future prompt() invocations replay them.
    const sessionActive = this.config.agentRuntime
      ? this.config.agentRuntime.isRunning(session.id)
      : false;
    if (sessionActive) {
      log.debug(`Session ${session.id} is active, buffering message from ${msg.author.username}`);
      const pending = this.pendingMessages.get(session.id) ?? [];
      pending.push({
        content,
        sender: msg.author.username,
        timestamp: msg.createdTimestamp,
      });
      this.pendingMessages.set(session.id, pending);
      // Note: do not also append to channelHistory — onTurnEnd persists to
      // SessionStore, and channelHistory injection on the next trigger would
      // re-surface the same message a second time.
      return;
    }

    // 7. Consume channel history and build enriched content
    const historyEntries = (this.config.context?.channelHistory !== false && msg.guild)
      ? this.channelHistory.consumeAndClear(msg.channelId)
      : [];
    const enrichedContent = buildHistoryContext(historyEntries, content);

    // 8. Add user message to session with inbound metadata
    const messageMetadata = extractDiscordMetadata(msg);
    const chatType = msg.guild ? "group" : "direct";
    const inboundMeta = formatInboundMeta(messageMetadata, chatType);
    const contentWithMeta = `${inboundMeta}\n\n${enrichedContent}`;

    const images = await this.extractAttachmentImages(msg);
    const userMsg: AgentMessage = images.length > 0
      ? mkUserMsgWithImages(contentWithMeta, images, msg.createdTimestamp)
      : mkUserMsg(contentWithMeta, msg.createdTimestamp);
    await sessionStore.addMessage(session.id, userMsg);

    // 9. Run agent via runAgent (system prompt is derived per-call
    // from the registered agent's config + workspace).
    const agentConfig = this.config.agentRuntime?.getAgent(agentId)?.config;
    const cwd = agentConfig ? resolveAgentWorkspacePath(agentConfig) : undefined;
    await this.runAgentAndRespond(agentId, session.id, sessionStore, cwd, msg.channel as SendableChannel, msg.id);
  }

  private isDmAllowed(userId: string): boolean {
    const dmAccess = this.config.dmAccess;
    if (dmAccess?.policy) {
      switch (dmAccess.policy) {
        case "disabled": return false;
        case "allowlist": return dmAccess.allowlist?.includes(userId) ?? false;
      }
    }
    return false;
  }

  /** Resolve the effective group config. Default policy is fail-closed `"allowlist"`. */
  private resolveGroup(): {
    policy: "disabled" | "allowlist" | "open";
    channelAllowlist?: string[];
    guildAllowlist?: string[];
  } {
    const g = this.config.groupAccess;
    if (g?.policy || g?.channelAllowlist?.length || g?.guildAllowlist?.length) {
      return {
        policy: g.policy ?? "allowlist",
        channelAllowlist: g.channelAllowlist,
        guildAllowlist: g.guildAllowlist,
      };
    }
    return { policy: "allowlist" };
  }

  private shouldRespond(msg: DiscordMessage): boolean {
    // DM handling
    if (!msg.guild) {
      const allowed = this.isDmAllowed(msg.author.id);
      if (!allowed) {
        log.debug(`discord: drop dm from ${msg.author.id} (dmAccess policy)`);
      }
      return allowed;
    }

    // Group (guild) policy
    const group = this.resolveGroup();
    if (group.policy === "disabled") {
      log.debug(`discord: drop guild message ${msg.id} (groupAccess.policy=disabled)`);
      return false;
    }
    if (group.policy === "allowlist") {
      const channelOk = group.channelAllowlist?.includes(msg.channelId) ?? false;
      const guildOk = group.guildAllowlist?.includes(msg.guild.id) ?? false;
      if (!channelOk && !guildOk) {
        log.debug(
          `discord: drop guild message ${msg.id} (not in groupAccess allowlist, ` +
          `guild=${msg.guild.id} channel=${msg.channelId})`,
        );
        return false;
      }
    }

    // Check mention-based response using guild config
    const botId = this.client.user?.id;
    const isMentioned = botId ? msg.mentions.has(botId) : false;

    const requireMention = this.config.guilds?.[msg.guild.id]?.requireMention ?? true;

    const ok = shouldRespondToMessage({
      isMentioned,
      isDM: false,
      requireMention,
    });
    if (!ok) {
      log.info(
        `discord: skipping guild message ${msg.id} (reason=no-mention, guild=${msg.guild.id})`,
      );
    }
    return ok;
  }

  /**
   * Handle a message in a spawn agent thread.
   * Supports /stop and /cancel commands to kill the running spawn agent.
   */
  private async handleSpawnAgentThreadMessage(
    _msg: DiscordMessage,
    _task: { taskId: string; sessionId: string; channelId: string; threadId?: string; task: string },
    _content: string,
  ): Promise<void> {
    // Spawn agent thread routing was removed in #568; this method is a stub
    // pending removal of remaining call sites.
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

  private getSessionKey(msg: DiscordMessage): string {
    const botId = this.client.user?.id ?? "unknown";

    if (msg.thread) {
      return buildSessionKey("discord", botId, "thread", msg.thread.id);
    }
    if (!msg.guild) {
      return buildSessionKey("discord", botId, "dm", msg.author.id);
    }
    return buildSessionKey("discord", botId, "channel", msg.channelId);
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
  // Agent interaction
  // ---------------------------------------------------------------------------

  private async runAgentAndRespond(
    agentId: string,
    sessionId: string,
    sessionStore: SessionStore,
    cwd: string | undefined,
    channel: SendableChannel,
    triggerMessageId?: string,
  ): Promise<void> {
    // Start typing indicator
    const typing = this.startTyping(channel);

    const toolSummaries: string[] = [];
    let streamBuffer: SegmentedStreamBuffer | null = null;

    const runtime = this.config.agentRuntime;
    if (!runtime) {
      throw new Error("DiscordTransport.runAgentAndRespond requires agentRuntime");
    }

    try {
      // Create segmented stream buffer that sends new messages at sentence boundaries
      streamBuffer = new SegmentedStreamBuffer(async (text: string) => {
        const { replyToId, stripped } = parseReplyDirective(text, triggerMessageId);
        if (!stripped) return; // chunk was nothing but a directive
        // Chunk if needed and send. Reply marker (if any) goes on first chunk only.
        const chunks = this.chunkMessage(stripped);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (i === 0 && replyToId) {
            await channel.send({
              content: chunk,
              reply: { messageReference: replyToId, failIfNotExists: false },
            });
          } else {
            await channel.send(chunk);
          }
        }
      });

      // Create the agent loop runner function via runAgent.
      const runLoop = () => {
        return runAgent(runtime, {
          to: agentId,
          sessionId,
          content: "",
          ...(cwd ? { cwd } : {}),
          extraSystemPrompt: REPLY_DIRECTIVE_PROMPT,
          log,
          onEvent: (e) => {
            if (e.type === "message_update" && streamBuffer) {
              const ame = e.assistantMessageEvent;
              if (ame.type === "text_delta" && ame.delta.length > 0) {
                void streamBuffer.append(ame.delta);
              }
            }
            if (this.config.showToolCalls && e.type === "tool_execution_start") {
              toolSummaries.push(`🔧 ${e.toolName}`);
            }
          },
          onTurnEnd: async () => {
            const pending = this.pendingMessages.get(sessionId);
            if (!pending?.length) return null;
            const messages = pending.splice(0);
            for (const m of messages) {
              await sessionStore.addMessage(sessionId, mkUserMsg(m.content, m.timestamp));
            }
            const formatted = messages.map(m => `${m.sender}: ${m.content}`).join("\n");
            return `[Messages arrived while you were working]\n${formatted}`;
          },
        });
      };

      // Wrap the run in a Discord a2a stream context so any nested
      // spawn_agent tool call streams its sub-run to a dedicated thread,
      // and the (threadId → sessionId) mapping flows back here for /stop routing.
      const streamCtx: DiscordA2AStreamContext = {
        parentChannelId: channel.id,
        showToolCalls: this.config.showToolCalls ?? true,
        registerA2AThread: (threadId, sessionId) => {
          this.a2aThreads.set(threadId, sessionId);
        },
        unregisterA2AThread: (threadId) => {
          this.a2aThreads.delete(threadId);
        },
        sendMessage: async (channelId, content) => {
          const target = await this.client.channels.fetch(channelId);
          if (!target || !("send" in target)) throw new Error(`Cannot send to channel ${channelId}`);
          const msg = await (target as SendableChannel).send(content);
          return { id: msg.id };
        },
        createThread: async (parentChannelId, name, messageId) => {
          const parent = await this.client.channels.fetch(parentChannelId);
          if (!parent || !("threads" in parent)) {
            throw new Error(`Cannot create thread in channel ${parentChannelId}`);
          }
          const textChannel = parent as TextChannel;
          const message = await textChannel.messages.fetch(messageId);
          const thread = await message.startThread({ name, autoArchiveDuration: 60 });
          return { id: thread.id };
        },
      };

      const { responseText, errorMessage } = await runWithDiscordA2AStream(streamCtx, runLoop);

      // Check for silent reply tokens — suppress outbound delivery
      if (isSilentReplyPayloadText(responseText)) {
        log.info(`Silent reply detected (${responseText.trim()}), suppressing Discord send`);
        typing.stop();
        return;
      }

      // Flush any remaining content in the buffer
      await streamBuffer.flushRemaining();

      if (toolSummaries.length > 0) {
        await channel.send(toolSummaries.join("\n"));
      }

      if (errorMessage) {
        const finalErrorMessage = `❌ ${errorMessage}`;
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
      this.pendingMessages.delete(sessionId);
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

  private hasImageAttachments(msg: DiscordMessage): boolean {
    for (const [, a] of msg.attachments) {
      if (a.contentType?.startsWith("image/")) return true;
    }
    return false;
  }

  private async extractAttachmentImages(msg: DiscordMessage): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
    const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const MAX_BYTES = 10 * 1024 * 1024; // 10MB

    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

    for (const [, attachment] of msg.attachments) {
      const ct = attachment.contentType;
      if (!ct || !IMAGE_TYPES.has(ct)) continue;
      if (attachment.size > MAX_BYTES) {
        log.warn(`Skipping oversized image attachment (${attachment.size} bytes)`);
        continue;
      }

      try {
        const res = await fetch(attachment.url);
        if (!res.ok) {
          log.warn(`Failed to fetch attachment ${attachment.url}: ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        images.push({ type: "image", data: buffer.toString("base64"), mimeType: ct });
      } catch (err) {
        log.warn(`Error downloading attachment: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return images;
  }

  private async sendWithAttachments(
    channel: SendableChannel,
    text: string,
    attachments: Array<{ buffer: Buffer; name: string }>,
    replyToId?: string,
  ): Promise<void> {
    const files = attachments.map((a) => new AttachmentBuilder(a.buffer, { name: a.name }));
    const chunks = text ? this.chunkMessage(text) : [undefined];

    for (let i = 0; i < chunks.length; i++) {
      const opts: Record<string, unknown> = {};
      if (chunks[i]) opts.content = chunks[i];
      if (i === chunks.length - 1) opts.files = files;
      if (i === 0 && replyToId) opts.reply = { messageReference: replyToId, failIfNotExists: false };
      await channel.send(opts as Parameters<typeof channel.send>[0]);
    }
  }

  // ---------------------------------------------------------------------------
  // Reply & reaction
  // ---------------------------------------------------------------------------

  async reply(messageId: string, content: string, channelId?: string, attachments?: Array<{ buffer: Buffer; name: string }>): Promise<{ messageId: string }> {
    if (!this.ready) throw new Error("Discord transport not ready");

    const files = attachments?.length
      ? attachments.map((a) => new AttachmentBuilder(a.buffer, { name: a.name }))
      : undefined;

    const replyPayload = { content, ...(files ? { files } : {}) };

    // Fast path: fetch the channel directly when channelId is provided
    if (channelId) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && "messages" in channel) {
          const target = await (channel as SendableChannel).messages.fetch(messageId);
          const sent = await target.reply(replyPayload);
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
          const sent = await target.reply(replyPayload);
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
