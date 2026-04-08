// src/transports/feishu.ts — Feishu (Lark) transport for Isotopes
// Handles Feishu bot connection via WebSocket, message routing, and response streaming.

import { Client, WSClient, EventDispatcher, Domain } from "@larksuiteoapi/node-sdk";
import type {
  AgentInstance,
  AgentManager,
  Binding,
  ChannelsConfig,
  Message,
  SessionStore,
  Transport,
} from "../core/types.js";
import { textContent } from "../core/types.js";
import { resolveBinding } from "../core/bindings.js";
import type { BindingQuery } from "../core/bindings.js";
import { loggers } from "../core/logger.js";

const log = loggers.feishu;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event data for im.message.receive_v1 */
export interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;     // "p2p" (DM) or "group"
    message_type: string;  // "text", "image", etc.
    content: string;       // JSON string, e.g. '{"text":"hello"}'
    mentions?: Array<{
      key: string;          // e.g. "@_user_1"
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
}

export interface FeishuTransportConfig {
  /** Feishu app ID from Developer Console */
  appId: string;
  /** Feishu app secret from Developer Console */
  appSecret: string;
  agentManager: AgentManager;
  sessionStore: SessionStore;
  sessionStoreForAgent?: (agentId: string) => SessionStore;
  /** Default agent ID to use when no @mention routing */
  defaultAgentId?: string;
  /** Map of Feishu bot open_id → agent ID for multi-agent routing */
  agentBindings?: Record<string, string>;
  /** Binding rules for routing messages to agents by (channel, accountId, peer) */
  bindings?: Binding[];
  /** Channels config for per-group settings (e.g. requireMention) */
  channels?: ChannelsConfig;
  /** The account ID this bot is running as (for group config lookup) */
  accountId?: string;
  /** Domain: "feishu" (default) or "lark" (international) */
  domain?: "feishu" | "lark";
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from Feishu message content JSON.
 * Feishu sends text messages as JSON: {"text":"@_user_1 hello"}
 * Returns the text field value, or empty string if parsing fails.
 */
export function extractTextFromFeishuMessage(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

/**
 * Strip @mention placeholders from Feishu text content.
 * Feishu mentions appear as @_user_N in the text.
 */
export function stripFeishuMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").trim();
}

/**
 * Check if the bot is mentioned in a Feishu message.
 * Looks at the mentions array and matches against the bot's open_id.
 */
export function isBotMentioned(
  event: FeishuMessageEvent,
  botOpenId: string,
): boolean {
  if (!event.message.mentions) return false;
  return event.message.mentions.some(
    (m) => m.id.open_id === botOpenId,
  );
}

/**
 * Generate a session key for a Feishu chat.
 */
export function getFeishuSessionKey(
  botId: string,
  event: FeishuMessageEvent,
  agentId: string,
): string {
  const chatId = event.message.chat_id;
  const chatType = event.message.chat_type;

  if (chatType === "p2p") {
    const senderId = event.sender.sender_id?.open_id ?? "unknown";
    return `feishu:${botId}:dm:${senderId}:${agentId}`;
  }

  // Group chat (or thread within group)
  if (event.message.thread_id) {
    return `feishu:${botId}:thread:${event.message.thread_id}:${agentId}`;
  }

  return `feishu:${botId}:group:${chatId}:${agentId}`;
}

// ---------------------------------------------------------------------------
// FeishuTransport
// ---------------------------------------------------------------------------

/**
 * FeishuTransport — connects agents to Feishu/Lark via WebSocket.
 *
 * Features:
 * - WebSocket connection (no webhook server needed)
 * - @mention routing to specific agents
 * - Session per chat/thread
 * - Streaming responses
 * - Support for both P2P (DM) and group chats
 */
export class FeishuTransport implements Transport {
  private client: Client;
  private wsClient: WSClient | null = null;
  private config: FeishuTransportConfig;
  private botOpenId: string | null = null;

  constructor(config: FeishuTransportConfig) {
    if (!config.appId) throw new Error("FeishuTransport: appId is required");
    if (!config.appSecret) throw new Error("FeishuTransport: appSecret is required");

    this.config = config;

    const domain = config.domain === "lark" ? Domain.Lark : Domain.Feishu;

    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
    });
  }

  async start(): Promise<void> {
    // Fetch bot info to get open_id
    await this.fetchBotInfo();

    const eventDispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": (data) => this.handleMessage(data as FeishuMessageEvent),
    });

    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain === "lark" ? Domain.Lark : Domain.Feishu,
    });

    await this.wsClient.start({ eventDispatcher });
    log.info(`Feishu transport started (domain: ${this.config.domain ?? "feishu"})`);
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    log.info("Feishu transport stopped");
  }

  // ---------------------------------------------------------------------------
  // Bot info
  // ---------------------------------------------------------------------------

  private async fetchBotInfo(): Promise<void> {
    try {
      // Use raw request to call bot info API (no typed method in SDK)
      const resp = await this.client.request<{
        code?: number;
        data?: { bot?: { open_id?: string; app_name?: string } };
      }>({ url: "/bot/v3/info", method: "GET" });
      if (resp?.data?.bot) {
        this.botOpenId = resp.data.bot.open_id ?? null;
        log.info(`Bot info: ${resp.data.bot.app_name ?? "unknown"} (open_id: ${this.botOpenId})`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to fetch bot info, using appId as fallback: ${errorMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(event: FeishuMessageEvent): Promise<void> {
    // Only handle text messages
    if (event.message.message_type !== "text") {
      log.debug(`Ignoring non-text message type: ${event.message.message_type}`);
      return;
    }

    // Check if we should respond
    if (!this.shouldRespond(event)) return;

    const rawText = extractTextFromFeishuMessage(event.message.content);
    const content = stripFeishuMentions(rawText);

    if (!content.trim()) return;

    const senderId = event.sender.sender_id?.open_id ?? "unknown";
    log.debug(`Received message from ${senderId}: ${content.substring(0, 50)}...`);

    // Resolve agent
    const agentId = this.resolveAgentId(event);
    log.debug(`Routing message to agent: ${agentId}`);

    const agent = this.config.agentManager.get(agentId);
    if (!agent) {
      log.warn(`Agent "${agentId}" not found`);
      return;
    }

    const sessionStore = this.getSessionStore(agentId);

    // Get or create session
    const botId = this.botOpenId ?? this.config.appId;
    const sessionKey = getFeishuSessionKey(botId, event, agentId);
    const session = await this.findOrCreateSession(sessionStore, sessionKey, agentId, event);

    // Add user message to session
    const userMessage: Message = {
      role: "user",
      content: textContent(content),
      timestamp: parseInt(event.message.create_time, 10) || Date.now(),
      metadata: {
        userId: senderId,
        username: event.sender.sender_id?.user_id ?? senderId,
      },
    };
    await sessionStore.addMessage(session.id, userMessage);

    const promptInput = await sessionStore.getMessages(session.id);

    // Run agent and respond
    await this.runAgentAndRespond(
      agent,
      promptInput,
      event.message.chat_id,
      session.id,
      sessionStore,
    );
  }

  private shouldRespond(event: FeishuMessageEvent): boolean {
    const chatType = event.message.chat_type;

    // P2P (DM): always respond
    if (chatType === "p2p") return true;

    // Group chat: check mention requirements
    const botId = this.botOpenId ?? "";
    const mentioned = isBotMentioned(event, botId);

    // Check Feishu group config for requireMention
    const groupConfig = this.config.channels?.feishu?.groups;
    if (groupConfig) {
      const chatConfig = groupConfig[event.message.chat_id];
      if (chatConfig) {
        if (chatConfig.requireMention === false) return true;
        return mentioned;
      }
    }

    // Default: require mention in group chats
    return mentioned;
  }

  private resolveAgentId(event: FeishuMessageEvent): string {
    // 1. Try structured bindings (resolveBinding) — most specific match wins
    if (this.config.bindings?.length) {
      const chatType = event.message.chat_type;
      const query: BindingQuery = {
        channel: "feishu",
        accountId: this.config.accountId,
        peer: {
          kind: chatType === "p2p" ? "dm" : "group",
          id: chatType === "p2p"
            ? (event.sender.sender_id?.open_id ?? "unknown")
            : event.message.chat_id,
        },
      };

      const binding = resolveBinding(this.config.bindings, query);
      if (binding) {
        log.debug(`Binding resolved agent "${binding.agentId}" for query ${JSON.stringify(query)}`);
        return binding.agentId;
      }
    }

    // 2. Fall back to legacy agentBindings (mention-based open_id → agentId map)
    if (this.config.agentBindings && event.message.mentions) {
      for (const mention of event.message.mentions) {
        const openId = mention.id.open_id;
        if (openId && this.config.agentBindings[openId]) {
          return this.config.agentBindings[openId];
        }
      }
    }

    // 3. Fall back to default agent
    return this.config.defaultAgentId ?? "default";
  }

  private getSessionStore(agentId: string): SessionStore {
    return this.config.sessionStoreForAgent?.(agentId) ?? this.config.sessionStore;
  }

  private async findOrCreateSession(
    sessionStore: SessionStore,
    sessionKey: string,
    agentId: string,
    event: FeishuMessageEvent,
  ) {
    // Try to find existing session by key
    const existing = await sessionStore.findByKey(sessionKey);
    if (existing) return existing;

    // Create new session with key
    return sessionStore.create(agentId, {
      key: sessionKey,
      transport: "feishu",
      channelId: event.message.chat_id,
      threadId: event.message.thread_id,
    });
  }

  // ---------------------------------------------------------------------------
  // Agent interaction
  // ---------------------------------------------------------------------------

  private async runAgentAndRespond(
    agent: AgentInstance,
    input: string | Message[],
    chatId: string,
    sessionId: string,
    sessionStore: SessionStore,
  ): Promise<void> {
    try {
      let responseText = "";
      let finalErrorMessage: string | null = null;

      for await (const event of agent.prompt(input)) {
        if (event.type === "text_delta") {
          responseText += event.text;
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

      // Send final response
      if (responseText) {
        await this.sendTextMessage(chatId, responseText);
      }
      if (finalErrorMessage) {
        await sessionStore.addMessage(sessionId, {
          role: "assistant",
          content: textContent(finalErrorMessage),
          timestamp: Date.now(),
          metadata: { isError: true },
        });
        await this.sendTextMessage(chatId, finalErrorMessage);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Agent error: ${errorMsg}`);
      try {
        await this.sendTextMessage(chatId, "❌ An error occurred while processing your request.");
      } catch {
        // Ignore send failure
      }
    }
  }

  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    // Feishu has a message size limit; chunk if needed
    const chunks = this.chunkMessage(text);

    for (const chunk of chunks) {
      await this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
  }

  /**
   * Split a message into chunks suitable for Feishu's message size limit.
   * Feishu's limit is ~32KB for text messages; we use a conservative 4000 chars.
   */
  private chunkMessage(content: string, maxLength = 4000): string[] {
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
}
