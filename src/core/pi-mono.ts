// src/core/pi-mono.ts — Thin wrapper around @mariozechner/pi-agent-core Agent
// Implements the AgentCore / AgentInstance interfaces from types.ts.

import { Agent, type AgentEvent as CoreEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, completeSimple, type Model, type Api } from "@mariozechner/pi-ai";

import {
  messageContentToPlainText,
  textContent,
  type AgentConfig,
  type AgentCore,
  type AgentEvent,
  type AgentInstance,
  type Message,
  type MessageContentBlock,
  type Tool,
} from "./types.js";
import type { ToolRegistry } from "./tools.js";
import { createTransformContext, resolveCompactionConfig } from "./compaction.js";
import { createLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Default model — used when no provider config is specified
const DEFAULT_MODEL = "claude-opus-4.5";

const log = createLogger("pi-mono");

function cloneModel<TApi extends Api>(
  model: Model<TApi>,
  overrides: Partial<Pick<Model<TApi>, "id" | "name" | "baseUrl" | "headers">>,
): Model<TApi> {
  return {
    id: overrides.id ?? model.id,
    name: overrides.name ?? model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: overrides.baseUrl ?? model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...((model.headers || overrides.headers)
      ? { headers: { ...(model.headers ?? {}), ...(overrides.headers ?? {}) } }
      : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function resolveKnownModel(
  provider: Parameters<typeof getModel>[0],
  modelId: string,
): Model<Api> {
  const model = getModel(provider, modelId as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
  if (model) return model;

  // For Anthropic, try dashed variant (e.g. claude-opus-4.5 → claude-opus-4-5)
  if (provider === "anthropic") {
    const dashed = modelId.replace(/(claude-(?:opus|sonnet|haiku)-\d)\.(\d)/g, "$1-$2");
    if (dashed !== modelId) {
      const aliased = getModel(provider, dashed as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
      if (aliased) return aliased;
    }
  }

  throw new Error(`Unknown ${provider} model: ${modelId}`);
}

/** Resolve a pi-ai Model from our ProviderConfig. */
function resolveModel(config: AgentConfig): Model<Api> {
  const p = config.provider;
  const provider = (p?.type.replace(/-proxy$/, "") ?? "anthropic") as Parameters<typeof getModel>[0];
  const modelId = p?.model ?? DEFAULT_MODEL;
  const model = resolveKnownModel(provider, modelId);

  // Build proxy headers (Authorization injection for anthropic-proxy)
  const proxyHeaders = { ...(p?.headers ?? {}) };
  if (p?.type === "anthropic-proxy" && p.apiKey) {
    proxyHeaders.Authorization ??= `Bearer ${p.apiKey}`;
  }
  const headers = Object.keys(proxyHeaders).length > 0
    ? { ...(model.headers ?? {}), ...proxyHeaders }
    : undefined;

  if (p?.baseUrl || headers) {
    return cloneModel(model, { id: modelId, baseUrl: p?.baseUrl, headers });
  }

  return model;
}

/**
 * Convert our Message to a pi-agent-core AgentMessage.
 * Role mapping: our `tool_result` → pi-agent-core `toolResult`
 */
function toAgentMessage(msg: Message): AgentMessage {
  const roleMap: Record<string, string> = {
    user: "user",
    assistant: "assistant",
    tool_result: "toolResult",
  };
  const role = roleMap[msg.role] ?? msg.role;

  if (role === "toolResult") {
    const toolResult = msg.content.find(
      (block): block is Extract<MessageContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result",
    );
    return {
      role,
      content: toolResult?.output ?? messageContentToPlainText(msg.content),
      timestamp: msg.timestamp ?? Date.now(),
      ...(toolResult?.toolCallId ? { toolCallId: toolResult.toolCallId } : {}),
      ...(toolResult?.toolName ? { toolName: toolResult.toolName } : {}),
      ...(toolResult?.isError !== undefined ? { isError: toolResult.isError } : {}),
    } as unknown as AgentMessage;
  }

  return {
    role,
    content: msg.content,
    timestamp: msg.timestamp ?? Date.now(),
  } as AgentMessage;
}

/**
 * Convert a pi-agent-core AgentMessage to our Message.
 * Role mapping: pi-agent-core `toolResult` → our `tool_result`
 * Used when receiving agent_end event with full conversation history.
 */
function fromAgentMessage(msg: AgentMessage): Message {
  // AgentMessage is a union — pick what we can represent
  if ("role" in msg) {
    const m = msg as {
      role: string;
      content: unknown;
      timestamp?: number;
      stopReason?: string;
      errorMessage?: string;
    };
    const roleMap: Record<string, Message["role"]> = {
      user: "user",
      assistant: "assistant",
      toolResult: "tool_result",
    };
    const metadata: Record<string, unknown> = {};
    if (typeof m.stopReason === "string") {
      metadata.stopReason = m.stopReason;
    }
    if (typeof m.errorMessage === "string") {
      metadata.errorMessage = m.errorMessage;
    }
    return {
      role: roleMap[m.role] ?? "assistant",
      content: normalizeContentBlocks(m.content),
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }
  return { role: "assistant", content: textContent(String(msg)), timestamp: Date.now() };
}

function normalizeContentBlocks(content: unknown): MessageContentBlock[] {
  if (typeof content === "string") {
    return textContent(content);
  }

  if (Array.isArray(content)) {
    const blocks: MessageContentBlock[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const typed = block as {
        type?: unknown;
        text?: unknown;
        output?: unknown;
        isError?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
      };

      if (typed.type === "text" && typeof typed.text === "string") {
        blocks.push({ type: "text", text: typed.text });
        continue;
      }

      if (typed.type === "tool_result" && typeof typed.output === "string") {
        blocks.push({
          type: "tool_result",
          output: typed.output,
          ...(typeof typed.isError === "boolean" ? { isError: typed.isError } : {}),
          ...(typeof typed.toolCallId === "string" ? { toolCallId: typed.toolCallId } : {}),
          ...(typeof typed.toolName === "string" ? { toolName: typed.toolName } : {}),
        });
      }
    }

    if (blocks.length > 0) {
      return blocks;
    }
  }

  return textContent(JSON.stringify(content));
}

function getAgentEndMetadata(messages: Message[]): {
  stopReason?: string;
  errorMessage?: string;
} {
  const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  const metadata = assistantMessage?.metadata;

  return {
    stopReason:
      typeof metadata?.stopReason === "string" ? metadata.stopReason : undefined,
    errorMessage:
      typeof metadata?.errorMessage === "string" ? metadata.errorMessage : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

/**
 * Convert our Tool + handler to pi-agent-core AgentTool.
 */
function toAgentTool(tool: Tool, handler: (args: unknown) => Promise<string>): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as AgentTool["parameters"],
    label: tool.name,
    execute: async (_toolCallId, params) => {
      const result = await handler(params);
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// PiMonoCore
// ---------------------------------------------------------------------------

/**
 * PiMonoCore — {@link AgentCore} implementation backed by pi-agent-core.
 *
 * Wraps the `@mariozechner/pi-agent-core` Agent to create
 * {@link AgentInstance}s that stream {@link AgentEvent}s. Supports
 * context compaction, tool registries, and configurable LLM providers.
 */
export class PiMonoCore implements AgentCore {
  private toolRegistries = new Map<string, ToolRegistry>();

  /**
   * Set a tool registry to be used for a specific agent.
   */
  setToolRegistry(agentId: string, registry: ToolRegistry): void {
    this.toolRegistries.set(agentId, registry);
  }

  createAgent(config: AgentConfig): AgentInstance {
    const model = resolveModel(config);

    // Convert registered tools to AgentTools
    const tools: AgentTool[] = [];
    const toolRegistry = this.toolRegistries.get(config.id);
    if (toolRegistry) {
      for (const entry of toolRegistry.list()) {
        const toolEntry = toolRegistry.get(entry.name);
        if (toolEntry) {
          tools.push(toAgentTool(toolEntry.tool, toolEntry.handler));
        }
      }
    }

    // Build transformContext hook for context compaction
    let transformContext: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined;

    if (config.compaction && config.compaction.mode !== "off") {
      const compactionConfig = resolveCompactionConfig(config.compaction);
      log.info(`Context compaction enabled for agent "${config.id}" (mode: ${compactionConfig.mode})`);

      const summarize = async (prompt: string, _signal?: AbortSignal): Promise<string> => {
        const result = await completeSimple(model, {
          systemPrompt: "You are a concise summarizer. Output only the summary, nothing else.",
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        });
        // Extract text from the assistant message
        if (typeof result.content === "string") return result.content;
        if (Array.isArray(result.content)) {
          return result.content
            .filter((b): b is { type: "text"; text: string } => "type" in b && b.type === "text")
            .map((b) => b.text)
            .join("");
        }
        return String(result.content);
      };

      transformContext = createTransformContext({
        config: compactionConfig,
        summarize,
      });
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: config.systemPrompt,
        model,
        tools,
        messages: [],
      },
      ...(transformContext ? { transformContext } : {}),
      ...(config.provider?.apiKey
        ? { getApiKey: () => config.provider!.apiKey }
        : {}),
    });

    return new PiMonoInstance(agent);
  }
}

// ---------------------------------------------------------------------------
// PiMonoInstance — wraps a single pi-agent-core Agent instance
// ---------------------------------------------------------------------------

class PiMonoInstance implements AgentInstance {
  constructor(private agent: Agent) {}

  async *prompt(input: string | Message[]): AsyncIterable<AgentEvent> {
    // Subscribe before calling prompt so we don't miss events
    const events: (CoreEvent | null)[] = [];
    let resolve: (() => void) | null = null;

    const unsub = this.agent.subscribe((e: CoreEvent) => {
      events.push(e);
      resolve?.();
    });

    // Start the prompt (runs in background)
    const done = (
      typeof input === "string"
        ? this.agent.prompt(input)
        : this.agent.prompt(input.map(toAgentMessage))
    ).then(() => {
      events.push(null); // sentinel
      resolve?.();
    });

    try {
      let finished = false;
      while (!finished) {
        if (events.length === 0) {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
        while (events.length > 0) {
          const ev = events.shift()!;
          if (ev === null) {
            finished = true;
            break;
          }
          const mapped = mapEvent(ev);
          if (mapped) yield mapped;
        }
      }
      await done;
    } finally {
      unsub();
    }
  }

  abort(): void {
    this.agent.abort();
  }

  steer(msg: Message): void {
    this.agent.steer(toAgentMessage(msg));
  }

  followUp(msg: Message): void {
    this.agent.followUp(toAgentMessage(msg));
  }
}

// ---------------------------------------------------------------------------
// Event mapping: pi-agent-core AgentEvent → our AgentEvent
// ---------------------------------------------------------------------------

function mapEvent(e: CoreEvent): AgentEvent | null {
  switch (e.type) {
    case "turn_start":
      return { type: "turn_start" };

    case "turn_end":
      return { type: "turn_end" };

    case "message_update": {
      // Extract text deltas from the assistant message event
      const ame = e.assistantMessageEvent;
      if (ame.type === "text_delta") {
        return { type: "text_delta", text: ame.delta };
      }
      // Other sub-events (thinking, toolcall deltas) — skip for now
      return null;
    }

    case "tool_execution_start":
      return {
        type: "tool_call",
        id: e.toolCallId,
        name: e.toolName,
        args: e.args,
      };

    case "tool_execution_end":
      return {
        type: "tool_result",
        id: e.toolCallId,
        output:
          typeof e.result === "string"
            ? e.result
            : JSON.stringify(e.result),
        isError: e.isError,
      };

    case "agent_end": {
      const messages = e.messages.map(fromAgentMessage);
      const { stopReason, errorMessage } = getAgentEndMetadata(messages);
      return {
        type: "agent_end",
        messages,
        stopReason,
        errorMessage,
      };
    }

    // Events we intentionally skip
    case "agent_start":
    case "message_start":
    case "message_end":
    case "tool_execution_update":
      return null;

    default:
      return null;
  }
}
