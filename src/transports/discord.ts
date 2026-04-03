// src/transports/discord.ts — Discord transport with thread streaming

import {
  Client,
  GatewayIntentBits,
  Events,
  type Message as DiscordMessage,
  type TextChannel,
  type ThreadChannel,
  ChannelType,
} from 'discord.js';
import type { AgentEvent } from '../core/types.js';
import type { AgentManager } from '../orchestrator/agent-manager.js';
import type { SessionStore, SessionMetadata } from '../orchestrator/session-store.js';
import type { Transport } from './types.js';

export interface DiscordConfig {
  token: string;
  /** Map of channel IDs → agent IDs for routing */
  channelAgentMap?: Record<string, string>;
}

const MAX_MESSAGE_LENGTH = 2000;

export class DiscordTransport implements Transport {
  private client: Client;

  constructor(
    private config: DiscordConfig,
    private agentManager: AgentManager,
    private sessionStore: SessionStore,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    this.client.once(Events.ClientReady, (c) => {
      console.log(`[discord] Logged in as ${c.user.tag}`);
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.removeAllListeners();
    await this.client.destroy();
    console.log('[discord] Disconnected');
  }

  /** Stream AgentEvents to a Discord thread, batching text deltas */
  async streamToThread(
    thread: ThreadChannel,
    events: AsyncIterable<AgentEvent>,
  ): Promise<void> {
    let buffer = '';
    let lastSendTime = 0;
    const FLUSH_INTERVAL = 1000; // ms between edits
    let sentMessage: DiscordMessage | null = null;

    const flush = async () => {
      if (!buffer) return;
      const content = buffer.slice(0, MAX_MESSAGE_LENGTH);

      if (!sentMessage) {
        sentMessage = await thread.send(content);
      } else {
        await sentMessage.edit(content);
      }
      lastSendTime = Date.now();

      // If buffer exceeds limit, start a new message
      if (buffer.length > MAX_MESSAGE_LENGTH) {
        buffer = buffer.slice(MAX_MESSAGE_LENGTH);
        sentMessage = null;
      }
    };

    for await (const event of events) {
      switch (event.type) {
        case 'text_delta':
          buffer += event.text;
          if (Date.now() - lastSendTime >= FLUSH_INTERVAL) {
            await flush();
          }
          break;

        case 'tool_call':
          await flush();
          await thread.send(`🔧 *Calling tool: ${event.name}*`);
          break;

        case 'tool_result':
          if (event.isError) {
            await thread.send(`❌ Tool error: ${event.output.slice(0, 200)}`);
          }
          break;

        case 'error':
          await flush();
          await thread.send(`⚠️ Error: ${event.error.message}`);
          break;

        case 'done':
          // Final flush
          await flush();
          break;
      }
    }

    // Ensure anything remaining is flushed
    await flush();
  }

  /** Create a new thread in a text channel */
  async createThread(channelId: string, name: string): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }

    const thread = await (channel as TextChannel).threads.create({
      name,
      autoArchiveDuration: 60,
    });

    return thread;
  }

  // --- Private message handler ---

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    // Ignore bots (including ourselves)
    if (msg.author.bot) return;

    // Determine which agent should handle this message
    const agentId = this.resolveAgent(msg);
    if (!agentId) return;

    const agent = this.agentManager.get(agentId);
    if (!agent) return;

    try {
      // Get or create a thread for the conversation
      let thread: ThreadChannel;
      if (msg.channel.isThread()) {
        thread = msg.channel as ThreadChannel;
      } else {
        thread = await this.createThread(
          msg.channelId,
          `Chat with ${msg.author.displayName}`,
        );
      }

      // Create a session
      const metadata: SessionMetadata = {
        transport: 'discord',
        channelId: msg.channelId,
        threadId: thread.id,
      };

      const session = await this.sessionStore.create(agentId, metadata);

      // Store the user message
      await this.sessionStore.addMessage(session.id, {
        role: 'user',
        content: msg.content,
      });

      // Get conversation history
      const messages = await this.sessionStore.getMessages(session.id);

      // Stream the response
      const events = agent.prompt(messages);
      await this.streamToThread(thread, events);
    } catch (err) {
      console.error('[discord] Error handling message:', err);
    }
  }

  /** Resolve which agent should handle a message */
  private resolveAgent(msg: DiscordMessage): string | undefined {
    // Check @mention routing
    const mentionedUserId = this.client.user?.id;
    if (mentionedUserId && msg.mentions.has(mentionedUserId)) {
      // Find first available agent
      const agents = this.agentManager.list();
      return agents[0]?.id;
    }

    // Check channel→agent mapping
    if (this.config.channelAgentMap) {
      return this.config.channelAgentMap[msg.channelId];
    }

    return undefined;
  }
}
