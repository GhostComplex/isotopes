// src/core/openai-agents.ts — @openai/agents SDK wrapper implementing AgentCore

import { Agent, run, Runner, OpenAIProvider } from '@openai/agents';
import type {
  AgentCore,
  AgentConfig,
  AgentInstance,
  AgentEvent,
  Message,
} from './types.js';

/**
 * OpenAIAgentsCore — uses @openai/agents SDK under the hood.
 * Supports custom providers (OpenAI-compatible proxies) via ProviderConfig.
 */
export class OpenAIAgentsCore implements AgentCore {
  private defaultBaseUrl?: string;
  private defaultApiKey?: string;
  private defaultModel?: string;
  private runner: Runner;

  constructor(options?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.defaultBaseUrl = options?.baseUrl;
    this.defaultApiKey = options?.apiKey;
    this.defaultModel = options?.model;

    // Create an OpenAI Provider using chat completions (compatible with proxies)
    const provider = new OpenAIProvider({
      baseURL: this.defaultBaseUrl,
      apiKey: this.defaultApiKey ?? 'not-needed',
      useResponses: false,
    });

    this.runner = new Runner({
      modelProvider: provider,
    });
  }

  createAgent(config: AgentConfig): AgentInstance {
    const model = config.provider?.model ?? this.defaultModel ?? 'gpt-4o';

    // Create the @openai/agents Agent
    const agent = new Agent({
      name: config.name,
      instructions: config.systemPrompt,
      model,
    });

    let abortController = new AbortController();

    const instance: AgentInstance = {
      prompt: async function* (input: string | Message[]): AsyncIterable<AgentEvent> {
        abortController = new AbortController();

        const inputStr = typeof input === 'string'
          ? input
          : input
              .filter((m) => m.role === 'user')
              .map((m) => m.content)
              .join('\n');

        try {
          // Use streaming mode
          const result = await run(agent, inputStr, {
            signal: abortController.signal,
            stream: true,
          });

          const collectedMessages: Message[] = [];
          let fullText = '';

          // Iterate over streaming events
          for await (const event of result) {
            if (event.type === 'raw_model_stream_event') {
              const data = event.data as Record<string, unknown>;
              if (data.type === 'content_part_delta') {
                const delta = (data as { delta?: { text?: string } }).delta;
                if (delta?.text) {
                  fullText += delta.text;
                  yield { type: 'text_delta', text: delta.text };
                }
              }
            } else if (event.type === 'run_item_stream_event') {
              if (event.name === 'tool_called' && event.item.type === 'tool_call_item') {
                const rawItem = event.item.rawItem as Record<string, unknown> | undefined;
                if (rawItem && rawItem.type === 'function_call') {
                  yield {
                    type: 'tool_call',
                    id: rawItem.callId as string,
                    name: rawItem.name as string,
                    args: JSON.parse((rawItem.arguments as string) || '{}'),
                  };
                }
              } else if (event.name === 'tool_output' && event.item.type === 'tool_call_output_item') {
                const rawItem = event.item.rawItem as Record<string, unknown> | undefined;
                if (rawItem && rawItem.type === 'function_call_result') {
                  const output = rawItem.output as { type?: string; text?: string } | undefined;
                  yield {
                    type: 'tool_result',
                    id: rawItem.callId as string,
                    output: output?.type === 'text' ? output.text ?? '' : JSON.stringify(output),
                  };
                }
              }
            }
          }

          // Collect final output
          const finalOutput = result.finalOutput;
          if (typeof finalOutput === 'string' && finalOutput) {
            collectedMessages.push({ role: 'assistant', content: finalOutput });
          } else if (fullText) {
            collectedMessages.push({ role: 'assistant', content: fullText });
          }

          yield { type: 'done', messages: collectedMessages };
        } catch (err) {
          if (abortController.signal.aborted) return;
          yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
        }
      },

      abort() {
        abortController.abort();
      },
    };

    return instance;
  }
}
