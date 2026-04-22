// src/core/pi-mono.ts — Thin wrapper around @mariozechner/pi-agent-core Agent
// Implements the AgentCore / AgentInstance interfaces from types.ts.

import { Agent, type AgentEvent as CoreEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, type Model, type Api } from "@mariozechner/pi-ai";

import {
  type AgentConfig,
  type AgentCore,
  type AgentEvent,
  type AgentInstance,
  type Message,
  type Tool,
  type Usage,
} from "./types.js";
import type { ToolRegistry } from "./tools.js";
import {
  createTransformContext,
  resolveCompactionConfig,
  isContextOverflow,
  forceCompact,
  iterativeCompact,
  estimateTotalTokens,
} from "./compaction.js";
import { sanitizeToolUseResultPairing } from "./context.js";
import { toAgentMessage, fromAgentMessage } from "./message-convert.js";
import { createLogger } from "./logger.js";
import * as fs from "node:fs";
import * as path from "node:path";

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
// Orphaned toolResult stripping (#146)
// ---------------------------------------------------------------------------

/**
 * Strip `toolResult` messages whose corresponding assistant `toolCall` is
 * missing from the context.  This happens when the SDK's `transformMessages`
 * drops errored/aborted assistant messages but keeps their tool results,
 * which the Anthropic API then rejects as orphaned `tool_result` blocks.
 *
 * Operates on `AgentMessage[]` (pi-agent-core format).
 */
export function stripOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
  // Collect all toolCall IDs present in non-errored/non-aborted assistants
  const validToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const m = msg as { role: string; stopReason?: string; content?: unknown };
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === "object" && "type" in block && block.type === "toolCall" && "id" in block) {
        validToolCallIds.add(block.id as string);
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.role !== "toolResult") return true;
    const m = msg as { role: string; toolCallId?: string };
    // Keep if toolCallId matches a valid (non-errored) assistant toolCall
    if (m.toolCallId && !validToolCallIds.has(m.toolCallId)) {
      log.debug(`Stripping orphaned toolResult (toolCallId: ${m.toolCallId})`);
      return false;
    }
    return true;
  });
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

/** Options passed to PiMonoInstance for overflow recovery */
interface CompactionContext {
  config: ReturnType<typeof resolveCompactionConfig>;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
}

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

  /**
   * Drop the tool registry binding for an agent id. Used by short-lived
   * subagent runs to release per-spawn registries after the agent exits.
   */
  clearToolRegistry(agentId: string): void {
    this.toolRegistries.delete(agentId);
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

    // Build transformContext hook — always includes orphaned toolResult
    // stripping (#146), with compaction layered on top if enabled.
    let compactionTransform: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined;
    let compactionContext: CompactionContext | undefined;

    const apiKey = config.provider?.apiKey ?? "";

    if (config.compaction && config.compaction.mode !== "off") {
      const compactionConfig = resolveCompactionConfig(config.compaction);
      log.info(`Context compaction enabled for agent "${config.id}" (mode: ${compactionConfig.mode})`);

      compactionTransform = createTransformContext({
        config: compactionConfig,
        model,
        apiKey,
        headers: config.provider?.headers,
      });

      compactionContext = { config: compactionConfig, model, apiKey, headers: config.provider?.headers };
    }

    const transformContext = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
      // Strip orphaned toolResult messages whose assistant (with the
      // matching toolCall) was dropped by the SDK due to error/abort (#146).
      const sanitized = stripOrphanedToolResults(messages);
      // Then apply compaction if configured
      if (compactionTransform) {
        return compactionTransform(sanitized, signal);
      }
      return sanitized;
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: config.systemPrompt,
        model,
        tools,
        messages: [],
      },
      transformContext,
      ...(config.provider?.apiKey
        ? { getApiKey: () => config.provider!.apiKey }
        : {}),
    });

    return new PiMonoInstance(agent, compactionContext);
  }
}

// ---------------------------------------------------------------------------
// PiMonoInstance — wraps a single pi-agent-core Agent instance
// ---------------------------------------------------------------------------

/** Maximum number of overflow recovery attempts */
const MAX_OVERFLOW_RETRIES = 2;

class PiMonoInstance implements AgentInstance {
  private promptQueue: Promise<void> = Promise.resolve();

  constructor(
    private agent: Agent,
    private compactionContext?: CompactionContext,
  ) {
    // Debug payload logger — logs LLM request context on each turn
    if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG) {
      this.agent.subscribe((e: CoreEvent) => {
        if (e.type === "agent_start") {
          this.logDebugPayload();
        }
      });
    }
  }

  /**
   * Log the current agent state (system prompt, messages, tools) for debugging.
   * Only active when LOG_LEVEL=debug or DEBUG is set.
   */
  private logDebugPayload(): void {
    try {
      const state = this.agent.state;
      const payload = {
        timestamp: new Date().toISOString(),
        systemPromptLength: state.systemPrompt?.length ?? 0,
        systemPrompt: state.systemPrompt,
        messagesCount: state.messages?.length ?? 0,
        messages: state.messages?.map((m) => {
          const msg = m as unknown as { role?: string; content?: unknown };
          const content = msg.content;
          return {
            role: msg.role,
            content:
              typeof content === "string"
                ? content.slice(0, 500)
                : JSON.stringify(content).slice(0, 500),
          };
        }),
        toolsCount: state.tools?.length ?? 0,
        toolNames: state.tools?.map((t) => t.name) ?? [],
      };
      const logDir = process.env.ISOTOPES_LOG_DIR || path.join(process.env.HOME || "/tmp", ".isotopes", "logs");
      fs.appendFileSync(
        path.join(logDir, "debug-payload.jsonl"),
        JSON.stringify(payload) + "\n",
      );
      log.debug("Payload logged to debug-payload.jsonl");
    } catch {
      // Silently ignore logging errors
    }
  }

  async *prompt(input: string | Message[]): AsyncIterable<AgentEvent> {
    let releaseQueue: (() => void) | undefined;
    const waitForTurn = this.promptQueue.catch(() => undefined);
    this.promptQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await waitForTurn;

    try {
      // Attempt prompt with overflow recovery
      yield* this.promptWithOverflowRecovery(input);
    } finally {
      releaseQueue?.();
    }
  }

  /**
   * Execute prompt with overflow detection and recovery.
   * If an overflow error is detected, compact context and retry.
   */
  private async *promptWithOverflowRecovery(
    input: string | Message[],
    retryCount = 0,
  ): AsyncIterable<AgentEvent> {
    const events: (CoreEvent | null)[] = [];
    let resolve: (() => void) | null = null;
    let overflowDetected = false;
    let overflowErrorMessage: string | undefined;

    const unsub = this.agent.subscribe((e: CoreEvent) => {
      // Check for overflow in agent_end events
      if (e.type === "agent_end") {
        const messages = e.messages.map(fromAgentMessage);
        const { errorMessage } = getAgentEndMetadata(messages);
        if (errorMessage && isContextOverflow(errorMessage)) {
          overflowDetected = true;
          overflowErrorMessage = errorMessage;
        }
      }
      events.push(e);
      resolve?.();
    });

    // Start the prompt (runs in background)
    const done = (
      typeof input === "string"
        ? this.agent.prompt(input)
        : this.agent.prompt(input.map(toAgentMessage))
    ).then(
      () => {
        events.push(null); // sentinel for normal completion
        resolve?.();
      },
      (err) => {
        // Check if the error itself indicates overflow
        const errMessage = err instanceof Error ? err.message : String(err);
        if (isContextOverflow(errMessage)) {
          overflowDetected = true;
          overflowErrorMessage = errMessage;
        }
        events.push(null);
        resolve?.();
        throw err;
      },
    );

    try {
      let finished = false;
      const collectedEvents: AgentEvent[] = [];

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
          if (mapped) {
            collectedEvents.push(mapped);
          }
        }
      }

      // Try to await done, but catch overflow errors
      try {
        await done;
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        if (isContextOverflow(errMessage)) {
          overflowDetected = true;
          overflowErrorMessage = errMessage;
        } else {
          // Re-throw non-overflow errors
          throw err;
        }
      }

      // Handle overflow recovery
      if (overflowDetected && this.compactionContext && retryCount < MAX_OVERFLOW_RETRIES) {
        log.warn(
          `Context overflow detected (attempt ${retryCount + 1}/${MAX_OVERFLOW_RETRIES}): ${overflowErrorMessage}`,
        );

        // Get current messages from agent state and perform iterative compaction
        const currentMessages = this.agent.state.messages;
        const tokensBefore = estimateTotalTokens(currentMessages);

        log.info(`Performing overflow recovery compaction: ~${tokensBefore} tokens in ${currentMessages.length} messages`);

        try {
          const compactedMessages = await iterativeCompact({
            messages: currentMessages,
            config: this.compactionContext.config,
            model: this.compactionContext.model,
            apiKey: this.compactionContext.apiKey,
            headers: this.compactionContext.headers,
            maxRounds: 3,
          });

          // Sanitize tool_use/tool_result pairing after compaction (#141)
          const sanitized = sanitizeToolUseResultPairing(
            compactedMessages.map(fromAgentMessage),
          ).map(toAgentMessage);

          const tokensAfter = estimateTotalTokens(sanitized);
          log.info(
            `Overflow recovery compaction complete: ~${tokensBefore} → ~${tokensAfter} tokens`,
          );

          // Replace agent messages with sanitized compacted version
          this.agent.state.messages = sanitized;

          // Retry the prompt with compacted context
          // Don't re-yield the failed events, start fresh
          yield* this.promptWithOverflowRecovery(input, retryCount + 1);
          return;
        } catch (compactErr) {
          log.error("Overflow recovery compaction failed", compactErr);
          // Fall through to yield original events
        }
      }

      // Yield all collected events
      for (const event of collectedEvents) {
        yield event;
      }
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

  clearMessages(): void {
    this.agent.reset();
  }

  getMessages(): Message[] {
    return this.agent.state.messages.map(fromAgentMessage);
  }

  /**
   * Force context compaction for overflow recovery.
   * Returns true if compaction occurred, false if not possible or not configured.
   */
  async forceCompact(): Promise<boolean> {
    if (!this.compactionContext) {
      log.warn("forceCompact called but compaction is not configured");
      return false;
    }

    const currentMessages = this.agent.state.messages;
    const preserveRecent = this.compactionContext.config.preserveRecent ?? 10;

    if (currentMessages.length <= preserveRecent) {
      log.warn(
        `Cannot force compact: only ${currentMessages.length} messages, need more than ${preserveRecent}`,
      );
      return false;
    }

    const tokensBefore = estimateTotalTokens(currentMessages);
    log.info(`Force compacting: ~${tokensBefore} tokens in ${currentMessages.length} messages`);

    try {
      const compactedMessages = await forceCompact({
        messages: currentMessages,
        config: this.compactionContext.config,
        model: this.compactionContext.model,
        apiKey: this.compactionContext.apiKey,
        headers: this.compactionContext.headers,
      });

      const tokensAfter = estimateTotalTokens(compactedMessages);
      log.info(`Force compaction complete: ~${tokensBefore} → ~${tokensAfter} tokens`);

      // Sanitize tool_use/tool_result pairing after compaction (#141)
      const sanitized = sanitizeToolUseResultPairing(
        compactedMessages.map(fromAgentMessage),
      ).map(toAgentMessage);

      this.agent.state.messages = sanitized;
      return true;
    } catch (err) {
      log.error("Force compaction failed", err);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Event mapping: pi-agent-core AgentEvent → our AgentEvent
// ---------------------------------------------------------------------------

function mapEvent(e: CoreEvent): AgentEvent | null {
  switch (e.type) {
    case "turn_start":
      return { type: "turn_start" };

    case "turn_end": {
      const msg = e.message;
      if (msg && "role" in msg && msg.role === "assistant" && "usage" in msg) {
        return { type: "turn_end", usage: msg.usage as Usage };
      }
      return { type: "turn_end" };
    }

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
