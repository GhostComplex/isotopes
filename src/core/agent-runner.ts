// src/core/agent-runner.ts — Shared agent event loop

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {  SessionStore } from "./types.js";
import type { PiMonoInstance } from "./pi-mono.js";
import { userMessage, assistantMessage, toolResultMessage } from "./messages.js";
import type { Logger } from "./logger.js";
import type { UsageTracker } from "./usage-tracker.js";
import type { HookRegistry } from "../plugins/hooks.js";

export const MAX_TOOL_RESULT_CHARS = 16_000;

function truncateToolResult(output: string): string {
  if (output.length <= MAX_TOOL_RESULT_CHARS) return output;
  const head = output.slice(0, MAX_TOOL_RESULT_CHARS);
  return `${head}\n...[truncated ${output.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

export interface AgentRunResult {
  responseText: string;
  errorMessage: string | null;
}

export type OnTextDelta = (currentText: string) => void | Promise<void>;

export interface RunAgentOptions {
  agent: PiMonoInstance;
  input: string | AgentMessage[];
  sessionId: string;
  sessionStore: SessionStore;
  log: Logger;
  onTextDelta?: OnTextDelta;
  usageTracker?: UsageTracker;
  onToolComplete?: () => Promise<string | null>;
  agentId?: string;
  hooks?: HookRegistry;
}

export async function runAgentLoop(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, input, sessionId, sessionStore, log, onTextDelta, usageTracker, onToolComplete, agentId, hooks } = opts;

  if (hooks && agentId) {
    await hooks.emit("message_received", {
      agentId,
      sessionId,
      message: typeof input === "string"
        ? userMessage(input)
        : input[input.length - 1],
    });
  }

  let responseText = "";
  let errorMessage: string | null = null;

  let turnText = "";
  interface ToolCallEntry { type: string; id: string; name: string; input: unknown }
  let turnToolCalls: ToolCallEntry[] = [];
  let turnToolResults: AgentMessage[] = [];
  const toolNameById = new Map<string, string>();

  const flushTurn = async (): Promise<void> => {
    if (turnText || turnToolCalls.length > 0) {
      const content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = [];
      if (turnText) content.push({ type: "text", text: turnText });
      for (const tc of turnToolCalls) {
        content.push({ type: "toolCall", id: tc.id, name: tc.name, input: tc.input });
      }
      await sessionStore.addMessage(sessionId, {
        role: "assistant",
        content,
        timestamp: Date.now(),
      } as AgentMessage);
    }
    for (const msg of turnToolResults) {
      await sessionStore.addMessage(sessionId, msg);
    }
    turnText = "";
    turnToolCalls = [];
    turnToolResults = [];
  };

  for await (const event of agent.prompt(input)) {
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        responseText += ame.delta;
        turnText += ame.delta;
        if (onTextDelta) {
          await onTextDelta(responseText);
        }
      }
    } else if (event.type === "tool_execution_start") {
      log.debug(`Tool call: ${event.toolName}`, { id: event.toolCallId });
      toolNameById.set(event.toolCallId, event.toolName);
      turnToolCalls.push({
        type: "toolCall",
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      log.debug(`Tool result: ${event.toolCallId}`);
      const toolName = toolNameById.get(event.toolCallId) ?? "unknown";
      const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      turnToolResults.push(
        toolResultMessage(
          truncateToolResult(output),
          event.toolCallId,
          toolName,
          { isError: event.isError },
        ),
      );
    } else if (event.type === "turn_end") {
      const msg = event.message;
      if (usageTracker && msg && "usage" in msg) {
        usageTracker.record(sessionId, (msg as unknown as { usage: unknown }).usage as Parameters<typeof usageTracker.record>[1]);
      }

      await flushTurn();

      if (onToolComplete) {
        const pendingContext = await onToolComplete();
        if (pendingContext) {
          log.debug(`Injecting pending messages via steer()`);
          agent.steer(userMessage(pendingContext));
        }
      }
    } else if (event.type === "agent_end") {
      await flushTurn();

      if (hooks && agentId && responseText) {
        await hooks.emit("message_sending", {
          agentId,
          sessionId,
          message: assistantMessage(responseText),
        });
      }

      const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
      const stopReason = (lastAssistant as unknown as { stopReason?: string })?.stopReason;
      const errMsg = (lastAssistant as unknown as { errorMessage?: string })?.errorMessage;
      if (stopReason === "error") {
        const msg = errMsg ?? "Unknown agent error";
        log.error(`Agent ended with error: ${msg}`);
        errorMessage = msg;
      }

      if (hooks && agentId) {
        await hooks.emit("agent_end", { agentId, stopReason });
      }
    }
  }

  return { responseText, errorMessage };
}
