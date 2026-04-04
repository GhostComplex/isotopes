// src/core/pi-mono.ts — Thin wrapper around @mariozechner/pi-agent-core Agent
// Implements the AgentCore / AgentInstance interfaces from types.ts.

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent as CoreEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";

import type {
  AgentConfig,
  AgentCore,
  AgentEvent,
  AgentInstance,
  Message,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Default model — used when no provider config is specified
const DEFAULT_MODEL = "claude-opus-4.5";

/** Resolve a pi-ai Model from our ProviderConfig. */
function resolveModel(config: AgentConfig): Model<Api> {
  const p = config.provider;
  if (!p) {
    // sensible default
    return getModel("anthropic", DEFAULT_MODEL as Parameters<typeof getModel>[1]) as Model<Api>;
  }
  const provider = p.type.replace(/-proxy$/, "") as Parameters<typeof getModel>[0];
  const modelId = (p.model ?? DEFAULT_MODEL) as Parameters<typeof getModel>[1];
  const model = getModel(provider, modelId) as Model<Api>;
  if (p.baseUrl) {
    // Override baseUrl for proxy setups
    return { ...model, baseUrl: p.baseUrl };
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
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }
  return { role: "assistant", content: String(msg), timestamp: Date.now() };
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
// PiMonoCore
// ---------------------------------------------------------------------------

export class PiMonoCore implements AgentCore {
  createAgent(config: AgentConfig): AgentInstance {
    const model = resolveModel(config);

    const agent = new Agent({
      initialState: {
        systemPrompt: config.systemPrompt,
        model,
        tools: [],          // tools wired separately
        messages: [],
      },
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
