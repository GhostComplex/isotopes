// src/transports/feishu.ts — Feishu (Lark) transport for Isotopes
// Handles Feishu bot connection via WebSocket, message routing, and response streaming.
// M2.1: P2P (DM) messages
// M2.2: Group message handling with @mention gating
// M2.3: Per-group requireMention configuration
// M2.4: Bindings integration for agent routing

import * as lark from "@larksuiteoapi/node-sdk";
import type {
  AgentInstance,
  AgentManager,
  Binding,
  BindingPeer,
  ChannelsConfig,
  Message,
  SessionStore,
  Transport,
} from "../core/types.js";
import { textContent } from "../core/types.js";
import { resolveBinding } from "../core/bindings.js";
import { loggers } from "../core/logger.js";

const log = loggers.feishu;

// ---------------------------------------------------------------------------
// Feishu message content helpers
// ---------------------------------------------------------------------------

/** Feishu text message content JSON structure */
interface FeishuTextContent {
  text: string;
}

/**
 * Extract plain text from a Feishu message content JSON string.
 *
 * Feishu wraps message content in a JSON string whose shape depends on
 * `message_type`. For "text" messages the shape is `{"text":"..."}`.
 * For unsupported types we return null.
 */
export function extractTextFromFeishuMessage(
  content: string,
  messageType: string,
): string | null {
  if (messageType !== "text") {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as FeishuTextContent;
    return parsed.text ?? null;
  } catch {
    log.warn(`Failed to parse Feishu message content: ${content}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mention helpers
// ---------------------------------------------------------------------------

/**
 * Strip Feishu @mention placeholders from message text.
 *
 * Feishu inserts `@_user_N` tokens (e.g. `@_user_1`, `@_user_2`) into the
 * text content when someone is mentioned. This function removes them and
 * collapses any leftover whitespace so the agent sees clean input.
 */
export function stripFeishuMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Check whether the bot itself is mentioned in a Feishu message.
 *
 * The `mentions` array on a Feishu message event contains entries with an
 * `id.open_id` that we compare against the bot's own open_id.
 */
export function isBotMentioned(
  mentions: FeishuMessageEvent["message"]["mentions"],
  botOpenId: string,
): boolean {
  if (!mentions || mentions.length === 0) return false;
  return mentions.some(
    (m) => m.id.open_id === botOpenId,
  );
}

// ---------------------------------------------------------------------------
// Group response logic
// ---------------------------------------------------------------------------

/**
 * Determine whether the bot should respond to a group message based on config.
 *
 * Looks up `channels.feishu.groups[chatId].requireMention`:
 *   - `requireMention: false` → respond to all messages in that group
 *   - `requireMention: true` (default) → only respond when @mentioned
 *   - No config → default to requiring @mention
 */
export function shouldRespondToGroupMessage(
  chatId: string,
  isMentioned: boolean,
  channels?: ChannelsConfig,
  _accountId?: string,
): boolean {
  if (!channels?.feishu?.groups) {
    return isMentioned;
  }

  const groupConfig = channels.feishu.groups[chatId];
  if (!groupConfig) {
    return isMentioned;
  }

  const requireMention = groupConfig.requireMention ?? true;
  if (!requireMention) {
    return true;
  }

  return isMentioned;
}

// ---------------------------------------------------------------------------
// Session key helpers
// ---------------------------------------------------------------------------

/**
 * Build a session key for a Feishu conversation.
 *
 * P2P (DM):  `feishu:{botId}:dm:{userId}:{agentId}`
 * Group:     `feishu:{botId}:group:{chatId}:{agentId}`
 */
export function buildFeishuSessionKey(
  botId: string,
  scopeId: string,
  agentId: string,
  chatType: "p2p" | "group" = "p2p",
): string {
  const scope = chatType === "group" ? "group" : "dm";
  return `feishu:${botId}:${scope}:${scopeId}:${agentId}`;
}

// ---------------------------------------------------------------------------
// Config & types
// ---------------------------------------------------------------------------

export interface FeishuTransportConfig {
  /** Feishu app ID from Developer Console */
  appId: string;
  /** Feishu app secret from Developer Console */
  appSecret: string;
  agentManager: AgentManager;
  sessionStore: SessionStore;
  /** Default agent ID to use for incoming messages */
  defaultAgentId?: string;
  /** Bot's open_id — required for detecting @mentions in group chats */
  botOpenId?: string;
  /** Channels config for per-group settings (e.g. requireMention) */
  channels?: ChannelsConfig;
  /** The account ID this bot is running as (for group config lookup) */
  accountId?: string;
  /** Agent ↔ channel bindings for routing messages to agents */
  bindings?: Binding[];
  /** Legacy per-bot agent bindings: { [botOpenId]: agentId } */
  agentBindings?: Record<string, string>;
}

/** Shape of the im.message.receive_v1 event data from the Feishu SDK */
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
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Agent resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which agent should handle a Feishu message.
 *
 * Resolution order (first match wins):
 *   1. Bindings system: resolveBinding(bindings, { channel, accountId, peer })
 *   2. Legacy agentBindings map: agentBindings[botOpenId]
 *   3. defaultAgentId fallback
 *   4. undefined — no agent can handle this message
 */
export function resolveAgentId(
  bindings: Binding[] | undefined,
  agentBindings: Record<string, string> | undefined,
  defaultAgentId: string | undefined,
  channel: string,
  accountId: string | undefined,
  peer: BindingPeer | undefined,
): string | undefined {
  // 1. Try bindings system (most specific match)
  if (bindings && bindings.length > 0) {
    const binding = resolveBinding(bindings, { channel, accountId, peer });
    if (binding) return binding.agentId;
  }

  // 2. Try legacy agentBindings (keyed by botOpenId, passed as accountId)
  if (agentBindings && accountId && agentBindings[accountId]) {
    return agentBindings[accountId];
  }

  // 3. Fall back to defaultAgentId
  return defaultAgentId;
}

// ---------------------------------------------------------------------------
// FeishuTransport
// ---------------------------------------------------------------------------

/**
 * FeishuTransport — connects agents to Feishu via WebSocket long connection.
 *
 * M2.1: WebSocket connection, P2P (DM) text messages
 * M2.2: Group message handling with @mention gating
 * M2.3: Per-group requireMention configuration
 */
export class FeishuTransport implements Transport {
  private config: FeishuTransportConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private started = false;

  constructor(config: FeishuTransportConfig) {
    this.config = config;

    // Create API client for sending messages
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    // Create event dispatcher and register handler
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: FeishuMessageEvent) => {
        await this.handleMessageEvent(data);
      },
    });

    // Create WebSocket client
    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      log.warn("FeishuTransport already started");
      return;
    }

    log.info("Starting Feishu WebSocket connection...");

    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    this.started = true;
    log.info("Feishu WebSocket connection established");
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    log.info("Stopping Feishu WebSocket connection...");
    this.wsClient.close();
    this.started = false;
    log.info("Feishu WebSocket connection closed");
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessageEvent(data: FeishuMessageEvent): Promise<void> {
    const { sender, message } = data;

    // Filter out non-user messages (bot self-messages, system messages)
    if (sender.sender_type !== "user") {
      log.debug(`Ignoring non-user message (sender_type: ${sender.sender_type})`);
      return;
    }

    // In groups, check whether the bot should respond (config-driven)
    if (message.chat_type === "group") {
      const botOpenId = this.config.botOpenId;
      const mentioned = botOpenId ? isBotMentioned(message.mentions, botOpenId) : false;
      if (!shouldRespondToGroupMessage(message.chat_id, mentioned, this.config.channels, this.config.accountId)) {
        log.debug("Ignoring group message: bot not mentioned and requireMention is enabled");
        return;
      }
    }

    // Extract text content
    const rawText = extractTextFromFeishuMessage(message.content, message.message_type);
    if (!rawText || !rawText.trim()) {
      log.debug(`Ignoring empty or non-text message (type: ${message.message_type})`);
      return;
    }

    // Strip @mention tokens for clean agent input
    const text = message.chat_type === "group" ? stripFeishuMentions(rawText) : rawText;
    if (!text) {
      log.debug("Ignoring message: empty after stripping mentions");
      return;
    }

    const userId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "unknown";
    log.debug(`Received ${message.chat_type} message from user ${userId}: ${text.substring(0, 50)}...`);

    // Resolve agent via bindings → agentBindings → defaultAgentId
    const peer: BindingPeer | undefined =
      message.chat_type === "group"
        ? { kind: "group", id: message.chat_id }
        : { kind: "dm", id: userId };

    const agentId = resolveAgentId(
      this.config.bindings,
      this.config.agentBindings,
      this.config.defaultAgentId,
      "feishu",
      this.config.accountId,
      peer,
    ) ?? "default";

    const agent = this.config.agentManager.get(agentId);
    if (!agent) {
      log.warn(`Agent "${agentId}" not found, ignoring message`);
      return;
    }

    // Get or create session — scoped by chat type
    const botId = this.config.appId;
    const scopeId = message.chat_type === "group" ? message.chat_id : userId;
    const sessionKey = buildFeishuSessionKey(botId, scopeId, agentId, message.chat_type as "p2p" | "group");
    const session = await this.findOrCreateSession(sessionKey, agentId);

    // Add user message to session
    const userMessage: Message = {
      role: "user",
      content: textContent(text),
      timestamp: parseInt(message.create_time, 10),
      metadata: {
        userId,
        messageId: message.message_id,
        chatId: message.chat_id,
      },
    };
    await this.config.sessionStore.addMessage(session.id, userMessage);

    // Retrieve full conversation history for the agent
    const promptInput = await this.config.sessionStore.getMessages(session.id);

    // Run agent and send reply
    await this.runAgentAndReply(agent, promptInput, message.chat_id, session.id);
  }

  private async findOrCreateSession(sessionKey: string, agentId: string) {
    const existing = await this.config.sessionStore.findByKey(sessionKey);
    if (existing) {
      return existing;
    }

    return this.config.sessionStore.create(agentId, {
      key: sessionKey,
      transport: "feishu",
    });
  }

  // ---------------------------------------------------------------------------
  // Agent interaction
  // ---------------------------------------------------------------------------

  private async runAgentAndReply(
    agent: AgentInstance,
    input: Message[],
    chatId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      let responseText = "";

      for await (const event of agent.prompt(input)) {
        if (event.type === "text_delta") {
          responseText += event.text;
        } else if (event.type === "agent_end") {
          // Store final assistant message
          if (responseText) {
            await this.config.sessionStore.addMessage(sessionId, {
              role: "assistant",
              content: textContent(responseText),
              timestamp: Date.now(),
            });
          }

          if (event.stopReason === "error") {
            const errorMsg = event.errorMessage ?? "Unknown agent error";
            log.error(`Agent ended with error: ${errorMsg}`);
            responseText = `Error: ${errorMsg}`;
          }
        }
      }

      // Send reply to Feishu
      if (responseText) {
        await this.sendTextMessage(chatId, responseText);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Agent error: ${errorMsg}`);
      try {
        await this.sendTextMessage(chatId, "An error occurred while processing your request.");
      } catch {
        log.error("Failed to send error message to Feishu");
      }
    }
  }

  /**
   * Send a text message to a Feishu chat.
   */
  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }
}
