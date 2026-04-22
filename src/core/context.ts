// src/core/context.ts — Prompt preparation transforms for context management.
// All functions are pure: AgentMessage[] in, new AgentMessage[] out, no mutation.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { messageText } from "./messages.js";

// ---------------------------------------------------------------------------
// limitHistoryTurns — truncate by user turn count
// ---------------------------------------------------------------------------

export function limitHistoryTurns(messages: AgentMessage[], limit: number): AgentMessage[] {
  if (limit <= 0 || messages.length === 0) return messages;

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// sanitizeToolUseResultPairing — fix broken pairs after truncation
// ---------------------------------------------------------------------------

interface ToolUseBlock {
  type: "tool_use" | "tool_call" | "toolCall";
  id: string;
  name?: string;
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (typeof block !== "object" || block === null) return false;
  const t = (block as Record<string, unknown>).type;
  return (
    (t === "tool_use" || t === "tool_call" || t === "toolCall") &&
    typeof (block as Record<string, unknown>).id === "string"
  );
}

function getToolUseIds(msg: AgentMessage): ToolUseBlock[] {
  if (msg.role !== "assistant") return [];
  const m = msg as unknown as { content?: unknown[] };
  if (!Array.isArray(m.content)) return [];
  return m.content.filter(isToolUseBlock);
}

export function sanitizeToolUseResultPairing(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) return messages;

  let startIdx = 0;
  while (startIdx < messages.length && messages[startIdx].role === "toolResult") {
    startIdx++;
  }
  const trimmed = startIdx > 0 ? messages.slice(startIdx) : messages;
  if (trimmed.length === 0) return [];

  const result: AgentMessage[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const msg = trimmed[i];
    result.push(msg);

    const toolUses = getToolUseIds(msg);
    if (toolUses.length === 0) continue;

    const foundResultIds = new Set<string>();
    for (let j = i + 1; j < trimmed.length; j++) {
      if (trimmed[j].role === "user") break;
      if (trimmed[j].role === "assistant" && getToolUseIds(trimmed[j]).length > 0) break;
      if (trimmed[j].role === "toolResult") {
        const m = trimmed[j] as unknown as { toolCallId?: string };
        if (m.toolCallId) foundResultIds.add(m.toolCallId);
      }
    }

    for (const tu of toolUses) {
      if (!foundResultIds.has(tu.id)) {
        result.push({
          role: "toolResult",
          content: "[Tool result unavailable — conversation truncated]",
          toolCallId: tu.id,
          toolName: tu.name ?? "unknown",
          isError: true,
          timestamp: Date.now(),
        } as unknown as AgentMessage);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// pruneToolResults — trim old tool results to save tokens
// ---------------------------------------------------------------------------

export interface PruneToolResultsOptions {
  protectRecent?: number;
  headChars?: number;
  tailChars?: number;
}

export function pruneToolResults(messages: AgentMessage[], opts?: PruneToolResultsOptions): AgentMessage[] {
  const protectRecent = opts?.protectRecent ?? 3;
  const headChars = opts?.headChars ?? 1500;
  const tailChars = opts?.tailChars ?? 1500;
  const importantTailChars = 4000;
  const minLenForTrim = headChars + tailChars + 50;

  let protectFrom = 0;
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= protectRecent) {
        protectFrom = i;
        break;
      }
    }
  }

  return messages.map((msg, i) => {
    if (i >= protectFrom) return msg;
    if (msg.role !== "toolResult") return msg;

    const text = messageText(msg);
    if (text.length < minLenForTrim) return msg;

    const effectiveTail = hasImportantTail(text) ? importantTailChars : tailChars;
    const budget = headChars + effectiveTail;
    if (text.length <= budget + 50) return msg;

    const trimmedText = text.slice(0, headChars) +
      "\n⚠️ [... middle content omitted — showing head and tail ...]\n" +
      text.slice(-effectiveTail);

    const content = (msg as unknown as { content?: unknown }).content;
    if (typeof content === "string") {
      return { ...msg, content: trimmedText } as unknown as AgentMessage;
    }
    return { ...msg, content: [{ type: "text", text: trimmedText }] } as unknown as AgentMessage;
  });
}

const IMPORTANT_TAIL_PATTERN =
  /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/i;

function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000);
  return IMPORTANT_TAIL_PATTERN.test(tail);
}

// ---------------------------------------------------------------------------
// pruneImages — replace old image blocks with placeholders
// ---------------------------------------------------------------------------

export interface PruneImagesOptions {
  keepRecentTurns?: number;
}

export function pruneImages(messages: AgentMessage[], opts?: PruneImagesOptions): AgentMessage[] {
  const keepRecentTurns = opts?.keepRecentTurns ?? 3;

  let protectFrom = 0;
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount >= keepRecentTurns) {
        protectFrom = i;
        break;
      }
    }
  }

  return messages.map((msg, i) => {
    if (i >= protectFrom) return msg;
    const m = msg as unknown as { content?: unknown[] };
    if (!Array.isArray(m.content)) return msg;

    const hasImage = (m.content as Array<Record<string, unknown>>).some(
      (block) => block.type === "image",
    );
    if (!hasImage) return msg;

    return {
      ...msg,
      content: (m.content as Array<Record<string, unknown>>).map((block) => {
        if (block.type === "image") {
          return { type: "text", text: "[image data removed — already processed by model]" };
        }
        return block;
      }),
    } as unknown as AgentMessage;
  });
}

// ---------------------------------------------------------------------------
// preparePromptMessages — orchestration entry point
// ---------------------------------------------------------------------------

export interface PromptPrepareOptions {
  historyTurns?: number;
  protectRecentAssistant?: number;
  toolResultHeadChars?: number;
  toolResultTailChars?: number;
  keepRecentImageTurns?: number;
}

export function preparePromptMessages(
  messages: AgentMessage[],
  opts?: PromptPrepareOptions,
): AgentMessage[] {
  let result = limitHistoryTurns(messages, opts?.historyTurns ?? 20);
  result = sanitizeToolUseResultPairing(result);
  result = pruneToolResults(result, {
    protectRecent: opts?.protectRecentAssistant ?? 3,
    headChars: opts?.toolResultHeadChars ?? 1500,
    tailChars: opts?.toolResultTailChars ?? 1500,
  });
  result = pruneImages(result, {
    keepRecentTurns: opts?.keepRecentImageTurns ?? 3,
  });
  return result;
}
