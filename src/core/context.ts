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
