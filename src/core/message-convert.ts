// src/core/message-convert.ts — Convert between isotopes Message and pi-agent-core AgentMessage

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message as PiMessage } from "@mariozechner/pi-ai";
import {
  textContent,
  messageContentToPlainText,
  type Message,
  type MessageContentBlock,
} from "./types.js";

export function toAgentMessage(msg: Message): AgentMessage {
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

  const content = role === "assistant"
    ? msg.content.map((block) => {
        if (block.type === "tool_call") {
          return { type: "toolCall", id: block.id, name: block.name, input: block.input };
        }
        return block;
      })
    : msg.content;

  return {
    role,
    content,
    timestamp: msg.timestamp ?? Date.now(),
  } as AgentMessage;
}

/** Narrower conversion for SessionManager.appendMessage() which expects pi-ai Message. */
export function toPiMessage(msg: Message): PiMessage {
  return toAgentMessage(msg) as unknown as PiMessage;
}

export function fromAgentMessage(msg: AgentMessage): Message {
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
    if (typeof m.stopReason === "string") metadata.stopReason = m.stopReason;
    if (typeof m.errorMessage === "string") metadata.errorMessage = m.errorMessage;

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
      if (!block || typeof block !== "object") continue;

      const typed = block as {
        type?: unknown; text?: unknown; output?: unknown; isError?: unknown;
        toolCallId?: unknown; toolName?: unknown; id?: unknown; name?: unknown;
        input?: unknown; arguments?: unknown;
      };

      if (typed.type === "text" && typeof typed.text === "string") {
        blocks.push({ type: "text", text: typed.text });
        continue;
      }

      if (
        (typed.type === "toolCall" || typed.type === "tool_call" || typed.type === "tool_use") &&
        typeof typed.id === "string" &&
        typeof typed.name === "string"
      ) {
        blocks.push({
          type: "tool_call",
          id: typed.id,
          name: typed.name,
          input: typed.input ?? typed.arguments ?? {},
        });
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
    if (blocks.length > 0) return blocks;
  }

  return textContent(JSON.stringify(content));
}
