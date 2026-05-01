import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../../logging/logger.js";
import {
  type ResolvedClaudeSpawningConfig,
  type SpawnPermissionMode,
} from "../../../config.js";
import type { RunRequest } from "../../types.js";
import { RunValidationError } from "../../types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

const log = createLogger("agents:runner:claude");

export type ClaudeConfigGetter = () => ResolvedClaudeSpawningConfig | undefined;

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
  constructor(private readonly getConfig: ClaudeConfigGetter) {}

  validateRequest(req: RunRequest): void {
    if (!this.getConfig()) {
      throw new RunValidationError("claude: not configured");
    }
    if (!req.cwd) throw new RunValidationError("claude: cwd is required");
  }

  async *run(opts: {
    request: RunRequest;
    runId: string;
    abort: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const { request, runId, abort } = opts;
    const cfg = this.getConfig();
    if (!cfg) throw new RunValidationError("claude: not configured");
    if (!request.cwd) throw new RunValidationError("claude: cwd is required");

    const sdkAbort = new AbortController();
    const onAbort = () => sdkAbort.abort();
    abort.addEventListener("abort", onAbort, { once: true });
    if (abort.aborted) sdkAbort.abort();

    const translated = translatePermissionMode(cfg.permissionMode, cfg.allowedTools);
    const sdkOptions: Options = {
      cwd: request.cwd,
      abortController: sdkAbort,
      permissionMode: translated.permissionMode,
      settingSources: cfg.settingSources ?? ["user"],
    };
    if (translated.allowedTools) sdkOptions.allowedTools = translated.allowedTools;

    log.info("ClaudeRunner.run", { runId, cwd: request.cwd });

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

// SDK-internal fields (partial, usage, provider, model) are type-asserted
// because consumeRootRun + send_message tool only read delta / messages.

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
