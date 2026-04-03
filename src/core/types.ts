// src/core/types.ts — Core interfaces for the Isotopes agent framework

/** A single message in a conversation */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** A tool definition exposed to the agent */
export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: (args: unknown) => Promise<string>;
}

/** Provider configuration — how to reach the LLM */
export interface ProviderConfig {
  type: 'openai-proxy' | 'anthropic-proxy' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** Configuration used to create an agent instance */
export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  tools?: Tool[];
  provider?: ProviderConfig;
}

/** Events yielded by an agent during streaming */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'done'; messages: Message[] }
  | { type: 'error'; error: Error };

/** A running agent instance */
export interface AgentInstance {
  /** Stream a prompt, yields events */
  prompt(input: string | Message[]): AsyncIterable<AgentEvent>;
  /** Abort current execution */
  abort(): void;
}

/** Pluggable agent core — swap implementations without changing upper layers */
export interface AgentCore {
  createAgent(config: AgentConfig): AgentInstance;
}
