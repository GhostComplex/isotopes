// src/core/agent-runner.ts — Shared agent event loop

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentInstance, SessionStore } from "./types.js";
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
  agent: AgentInstance;
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
    if (event.type === "text_delta") {
      responseText += event.text;
      turnText += event.text;
      if (onTextDelta) {
        await onTextDelta(responseText);
      }
    } else if (event.type === "tool_call") {
      log.debug(`Tool call: ${event.name}`, { id: event.id });
      toolNameById.set(event.id, event.name);
      turnToolCalls.push({
        type: "toolCall",
        id: event.id,
        name: event.name,
        input: event.args,
      });
    } else if (event.type === "tool_result") {
      log.debug(`Tool result: ${event.id}`);
      const toolName = toolNameById.get(event.id) ?? "unknown";
      turnToolResults.push(
        toolResultMessage(
          truncateToolResult(event.output),
          event.id,
          toolName,
          { isError: event.isError },
        ),
      );
    } else if (event.type === "turn_end") {
      if (usageTracker && event.usage) {
        usageTracker.record(sessionId, event.usage);
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

      if (event.stopReason === "error") {
        const msg = event.errorMessage ?? "Unknown agent error";
        log.error(`Agent ended with error: ${msg}`);
        errorMessage = msg;
      }

      if (hooks && agentId) {
        await hooks.emit("agent_end", { agentId, stopReason: event.stopReason });
      }
    }
  }

  return { responseText, errorMessage };
}
