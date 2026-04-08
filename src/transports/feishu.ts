// src/transports/feishu.ts — Feishu (Lark) transport for Isotopes
// Handles Feishu bot connection via WebSocket, message routing, and response streaming.
// M2.1 scope: P2P (DM) messages only — no group logic yet.

import * as lark from "@larksuiteoapi/node-sdk";
import type {
  AgentInstance,
  AgentManager,
  Message,
  SessionStore,
  Transport,
} from "../core/types.js";
import { textContent } from "../core/types.js";
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
// Session key helpers
// ---------------------------------------------------------------------------

/**
 * Build a session key for a Feishu DM conversation.
 *
 * Format: `feishu:{botId}:dm:{userId}:{agentId}`
 */
export function buildFeishuSessionKey(
  botId: string,
  userId: string,
  agentId: string,
): string {
  return `feishu:${botId}:dm:${userId}:${agentId}`;
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
// FeishuTransport
// ---------------------------------------------------------------------------

/**
 * FeishuTransport — connects agents to Feishu via WebSocket long connection.
 *
 * M2.1 scope:
 * - WebSocket connection via Lark SDK WSClient
 * - Receives im.message.receive_v1 events
 * - Handles P2P (DM) text messages only
 * - Sends text replies via client.im.message.create
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

    // M2.1: Only handle P2P (DM) messages
    if (message.chat_type !== "p2p") {
      log.debug(`Ignoring non-P2P message (chat_type: ${message.chat_type})`);
      return;
    }

    // Extract text content
    const text = extractTextFromFeishuMessage(message.content, message.message_type);
    if (!text || !text.trim()) {
      log.debug(`Ignoring empty or non-text message (type: ${message.message_type})`);
      return;
    }

    const userId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "unknown";
    log.debug(`Received DM from user ${userId}: ${text.substring(0, 50)}...`);

    // Resolve agent
    const agentId = this.config.defaultAgentId ?? "default";
    const agent = this.config.agentManager.get(agentId);
    if (!agent) {
      log.warn(`Agent "${agentId}" not found, ignoring message`);
      return;
    }

    // Get or create session
    const botId = this.config.appId;
    const sessionKey = buildFeishuSessionKey(botId, userId, agentId);
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
