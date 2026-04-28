// src/agents/runners/claude.ts — Claude CLI runner exposed via the unified
// runtime as a "leaf" target. `to: "claude"` from `send_message` reaches
// here. Internally drives @anthropic-ai/claude-agent-sdk's `query()` and
// translates SDKMessage → AgentEvent so the rest of the system (tool
// handler, agentEventBus, REST/SSE consumers) only ever sees one event
// taxonomy.

import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../core/logger.js";
import {
  DEFAULT_SPAWN_ALLOWED_TOOLS,
  type SettingSource,
  type SpawnPermissionMode,
} from "../../core/config.js";
import type { SendMessageRequest } from "../types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

const log = createLogger("agents:runner:claude");

export interface ClaudeRunnerOptions {
  permissionMode?: SpawnPermissionMode;
  allowedTools?: string[];
  settingSources?: SettingSource[];
  /** Default model when the request doesn't pin one. */
  model?: string;
  /** Default per-call max turns. */
  maxTurns?: number;
}

function translatePermissionMode(
  mode: SpawnPermissionMode,
  allowedTools: string[],
): { permissionMode: PermissionMode; allowedTools?: string[] } {
  switch (mode) {
    case "skip":
      return { permissionMode: "bypassPermissions" };
    case "allowlist":
      return { permissionMode: "default", allowedTools };
    case "default":
      return { permissionMode: "default" };
  }
}

export class ClaudeRunner {
  private readonly permissionMode: SpawnPermissionMode;
  private readonly allowedTools: string[];
  private readonly settingSources: SettingSource[];
  private readonly defaultModel?: string;
  private readonly defaultMaxTurns?: number;

  constructor(options?: ClaudeRunnerOptions) {
    this.permissionMode = options?.permissionMode ?? "allowlist";
    this.allowedTools = options?.allowedTools ?? [...DEFAULT_SPAWN_ALLOWED_TOOLS];
    this.settingSources = options?.settingSources ?? ["user"];
    if (options?.model) this.defaultModel = options.model;
    if (options?.maxTurns !== undefined) this.defaultMaxTurns = options.maxTurns;
  }

  /**
   * Drive a single Claude CLI invocation. Yields AgentEvents until the
   * SDK returns a `result` message.
   *
   * `request.cwd` is required (Claude CLI needs an explicit working
   * directory). `request.content` is the prompt sent to Claude as the
   * first/only user turn — Claude CLI manages its own session state, so
   * conversational continuity across calls is out of scope here.
   */
  async *sendMessage(opts: {
    request: SendMessageRequest;
    runId: string;
    abort: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const { request, runId, abort } = opts;
    if (!request.cwd) {
      throw new Error("ClaudeRunner.sendMessage: request.cwd is required");
    }

    const sdkAbort = new AbortController();
    const onAbort = () => sdkAbort.abort();
    abort.addEventListener("abort", onAbort, { once: true });
    if (abort.aborted) sdkAbort.abort();

    const translated = translatePermissionMode(this.permissionMode, this.allowedTools);
    const sdkOptions: Options = {
      cwd: request.cwd,
      abortController: sdkAbort,
      permissionMode: translated.permissionMode,
      settingSources: this.settingSources,
    };
    if (translated.allowedTools) sdkOptions.allowedTools = translated.allowedTools;
    if (this.defaultModel) sdkOptions.model = this.defaultModel;
    if (this.defaultMaxTurns !== undefined) sdkOptions.maxTurns = this.defaultMaxTurns;

    log.info("ClaudeRunner.sendMessage", { runId, cwd: request.cwd });

    const toolNameById = new Map<string, string>();
    let assistantText = "";
    let costUsd: number | undefined;
    let errorMessage: string | undefined;
    let stopReason: string = "end";

    try {
      const iterator = query({ prompt: request.content, options: sdkOptions });

      for await (const msg of iterator) {
        for (const ev of translateSdkMessage(msg, toolNameById)) {
          if (ev.kind === "text") {
            assistantText += ev.text;
            yield buildMessageUpdate(ev.text);
          } else if (ev.kind === "tool_call") {
            yield buildToolStart(ev.id, ev.name, ev.input);
          } else if (ev.kind === "tool_result") {
            yield buildToolEnd(ev.id, ev.name, ev.result, ev.isError);
          } else if (ev.kind === "result") {
            costUsd = ev.costUsd;
            if (ev.error) {
              stopReason = "error";
              errorMessage = ev.error;
            }
          }
        }
      }
    } catch (err) {
      stopReason = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      abort.removeEventListener("abort", onAbort);
    }

    yield buildAgentEnd(assistantText, stopReason, errorMessage, costUsd);
  }
}

// ---------------------------------------------------------------------------
// SDKMessage → intermediate translator (cheap step before AgentEvent shaping)
// ---------------------------------------------------------------------------

type Translated =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; name: string; result: unknown; isError: boolean }
  | { kind: "result"; costUsd?: number; error?: string };

function translateSdkMessage(msg: SDKMessage, toolNameById: Map<string, string>): Translated[] {
  const out: Translated[] = [];
  switch (msg.type) {
    case "assistant": {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            out.push({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            const id = String(block.id ?? "");
            const name = String(block.name ?? "");
            if (id) toolNameById.set(id, name);
            out.push({ kind: "tool_call", id, name, input: block.input });
          }
        }
      }
      break;
    }
    case "user": {
      if ("isReplay" in msg && msg.isReplay) break;
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
            const b = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
            const id = String(b.tool_use_id ?? "");
            out.push({
              kind: "tool_result",
              id,
              name: toolNameById.get(id) ?? id,
              result: b.content,
              isError: !!b.is_error,
            });
          }
        }
      }
      break;
    }
    case "result": {
      if (msg.subtype === "success") {
        out.push({ kind: "result", costUsd: msg.total_cost_usd });
      } else {
        const err = msg.errors?.join("; ") ?? msg.subtype;
        out.push({ kind: "result", costUsd: msg.total_cost_usd, error: err });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AgentEvent constructors. We only need fields that downstream consumers
// actually read (consumeRootRun + send_message tool); SDK-internal fields
// like `partial`, `usage`, `provider`, `model`, etc. are stubbed with
// type assertions because no consumer touches them.
// ---------------------------------------------------------------------------

function buildAssistantMessage(text: string, extras: { stopReason?: string; errorMessage?: string } = {}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: extras.stopReason ?? "end",
    ...(extras.errorMessage ? { errorMessage: extras.errorMessage } : {}),
  } as unknown as AgentMessage;
}

function buildMessageUpdate(delta: string): AgentEvent {
  const partial = buildAssistantMessage(delta) as unknown as AssistantMessage;
  const ame: AssistantMessageEvent = {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial,
  } as AssistantMessageEvent;
  return {
    type: "message_update",
    message: partial as unknown as AgentMessage,
    assistantMessageEvent: ame,
  };
}

function buildToolStart(toolCallId: string, toolName: string, args: unknown): AgentEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function buildToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): AgentEvent {
  return { type: "tool_execution_end", toolCallId, toolName, result, isError };
}

function buildAgentEnd(text: string, stopReason: string, errorMessage: string | undefined, _costUsd: number | undefined): AgentEvent {
  return {
    type: "agent_end",
    messages: [buildAssistantMessage(text, { stopReason, ...(errorMessage ? { errorMessage } : {}) })],
  };
}
