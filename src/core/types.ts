// src/core/types.ts — Core interfaces for the Isotopes agent framework
// Zero coupling to any specific agent SDK — these are OUR types.

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Events (streamed from AgentInstance.prompt)
// ---------------------------------------------------------------------------

// TODO: Consider separating lifecycle events (turn_start/turn_end/agent_end)
// from content events (text_delta/tool_call/tool_result) for cleaner handling.
// See OpenClaw's three-stream approach: lifecycle, assistant, tool.

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'turn_end' }
  | { type: 'agent_end'; messages: Message[] }
  | { type: 'error'; error: Error };

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  type: 'openai-proxy' | 'anthropic-proxy' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Agent config & instance
// ---------------------------------------------------------------------------

export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  tools?: Tool[];
  provider?: ProviderConfig;
}

export interface AgentInstance {
  prompt(input: string | Message[]): AsyncIterable<AgentEvent>;
  abort(): void;
  steer(msg: Message): void;
  followUp(msg: Message): void;
}

// ---------------------------------------------------------------------------
// Agent core — pluggable backend
// ---------------------------------------------------------------------------

export interface AgentCore {
  createAgent(config: AgentConfig): AgentInstance;
}

// ---------------------------------------------------------------------------
// Agent manager
// ---------------------------------------------------------------------------

export interface AgentManager {
  create(config: AgentConfig): Promise<AgentInstance>;
  get(id: string): AgentInstance | undefined;
  list(): AgentConfig[];
  update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  getPrompt(id: string): Promise<string>;
  updatePrompt(id: string, prompt: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  lastActiveAt: Date;
}

export interface SessionMetadata {
  transport: 'discord' | 'feishu' | 'web';
  channelId?: string;
  threadId?: string;
}

export interface SessionStoreConfig {
  dataDir: string;
  maxSessions?: number;       // default: 100
  maxTotalSizeMB?: number;    // default: 100
}

export interface SessionStore {
  create(agentId: string, metadata?: SessionMetadata): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  delete(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
