// src/core/context.ts — Prompt preparation transforms for context management.
// All functions are pure: Message[] in, new Message[] out, no mutation.

import type { Message, MessageContentBlock } from "./types.js";

// ---------------------------------------------------------------------------
// limitHistoryTurns — truncate by user turn count
// ---------------------------------------------------------------------------

/**
 * Keep the last `limit` user turns from a message array.
 *
 * A "turn" is one user message plus all immediately following non-user messages
 * (assistant replies, tool results, etc.). Counting by turns avoids slicing
 * mid-turn, which would produce an assistant-first sequence that some models reject.
 */
export function limitHistoryTurns(messages: Message[], limit: number): Message[] {
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

/** Duck-type check for tool_use blocks inside assistant message content. */
interface ToolUseBlock {
  type: "tool_use" | "tool_call";
  id: string;
  name?: string;
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (typeof block !== "object" || block === null) return false;
  const t = (block as Record<string, unknown>).type;
  return (
    (t === "tool_use" || t === "tool_call") &&
    typeof (block as Record<string, unknown>).id === "string"
  );
}

/** Extract tool_use block IDs from an assistant message's content. */
function getToolUseIds(msg: Message): ToolUseBlock[] {
  if (msg.role !== "assistant") return [];
  return (msg.content as unknown[]).filter(isToolUseBlock);
}

/**
 * Repair tool_use / tool_result pairing after truncation.
 *
 * 1. Drop orphaned leading tool_result messages (no preceding assistant with tool_use).
 * 2. For assistant messages with tool_use blocks but no matching tool_result,
 *    insert a synthetic error tool_result.
 */
export function sanitizeToolUseResultPairing(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  // Phase 1: drop orphaned leading tool_result messages
  let startIdx = 0;
  while (startIdx < messages.length && messages[startIdx].role === "tool_result") {
    startIdx++;
  }
  const trimmed = startIdx > 0 ? messages.slice(startIdx) : messages;
  if (trimmed.length === 0) return [];

  // Phase 2: ensure every tool_use has a matching tool_result
  const result: Message[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const msg = trimmed[i];
    result.push(msg);

    const toolUses = getToolUseIds(msg);
    if (toolUses.length === 0) continue;

    // Collect tool_result IDs from all following messages up to the next assistant
    // that has its own tool_use blocks (which starts a new pairing scope)
    const foundResultIds = new Set<string>();
    for (let j = i + 1; j < trimmed.length; j++) {
      if (trimmed[j].role === "user") break;
      if (trimmed[j].role === "assistant" && getToolUseIds(trimmed[j]).length > 0) break;
      if (trimmed[j].role === "tool_result") {
        // toolCallId may be in metadata or on the content block itself
        const firstBlock = trimmed[j].content[0] as { toolCallId?: string } | undefined;
        const callId = (trimmed[j].metadata?.toolCallId as string | undefined)
          ?? firstBlock?.toolCallId;
        if (callId) foundResultIds.add(callId);
      }
    }

    // Insert synthetic error results for missing pairs
    for (const tu of toolUses) {
      if (!foundResultIds.has(tu.id)) {
        result.push({
          role: "tool_result",
          content: [{ type: "tool_result", output: "[Tool result unavailable — conversation truncated]", isError: true, toolCallId: tu.id, toolName: tu.name }],
          timestamp: Date.now(),
          metadata: { toolCallId: tu.id, synthetic: true },
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// pruneToolResults — trim old tool results to save tokens
// ---------------------------------------------------------------------------

export interface PruneToolResultsOptions {
  /** Number of recent assistant messages to protect from pruning. Default: 3 */
  protectRecent?: number;
  /** Head characters to keep in soft-trimmed results. Default: 1500 */
  headChars?: number;
  /** Tail characters to keep in soft-trimmed results. Default: 1500 */
  tailChars?: number;
}

/**
 * Prune old tool_result messages to save tokens.
 *
 * - Protected zone: the last N assistant messages and everything after them
 *   are never pruned.
 * - Outside the protected zone: tool_result outputs longer than head+tail are
 *   soft-trimmed to keep only the head and tail portions.
 * - When the tail contains error/summary patterns, the tail budget is expanded
 *   to preserve diagnostically important content.
 */
export function pruneToolResults(messages: Message[], opts?: PruneToolResultsOptions): Message[] {
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
    if (msg.role !== "tool_result") return msg;

    const pruned = msg.content.map((block): MessageContentBlock => {
      if (block.type !== "tool_result") return block;
      if (block.output.length < minLenForTrim) return block;
      const effectiveTail = hasImportantTail(block.output) ? importantTailChars : tailChars;
      const budget = headChars + effectiveTail;
      if (block.output.length <= budget + 50) return block;
      return {
        ...block,
        output: block.output.slice(0, headChars) +
          "\n⚠️ [... middle content omitted — showing head and tail ...]\n" +
          block.output.slice(-effectiveTail),
      };
    });

    return { ...msg, content: pruned };
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
  /** Number of recent user turns to keep images in. Default: 3 */
  keepRecentTurns?: number;
}

/**
 * Replace image content blocks in old turns with text placeholders.
 * Uses duck-type check for `{type: "image"}` blocks — no-op if none exist.
 */
export function pruneImages(messages: Message[], opts?: PruneImagesOptions): Message[] {
  const keepRecentTurns = opts?.keepRecentTurns ?? 3;

  // Find the protection boundary by counting user turns from the end.
  // If fewer than N user turns exist, protect everything (protectFrom = 0).
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
    const hasImage = msg.content.some(
      (block) => (block as unknown as { type: string }).type === "image",
    );
    if (!hasImage) return msg;

    return {
      ...msg,
      content: msg.content.map((block): MessageContentBlock => {
        if ((block as unknown as { type: string }).type === "image") {
          return { type: "text", text: "[image data removed — already processed by model]" };
        }
        return block;
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// preparePromptMessages — orchestration entry point
// ---------------------------------------------------------------------------

export interface PromptPrepareOptions {
  /** Max user turns to keep. Default: 20 */
  historyTurns?: number;
  /** Number of recent assistant messages to protect from pruning. Default: 3 */
  protectRecentAssistant?: number;
  /** Head chars to keep in soft-trimmed tool results. Default: 1500 */
  toolResultHeadChars?: number;
  /** Tail chars to keep in soft-trimmed tool results. Default: 1500 */
  toolResultTailChars?: number;
  /** Number of recent turns to keep images in. Default: 3 */
  keepRecentImageTurns?: number;
}

/**
 * Prepare messages for prompt input by chaining all context transforms:
 *   1. Limit to last N user turns
 *   2. Fix broken tool_use/tool_result pairs
 *   3. Prune old tool results
 *   4. Prune old images
 */
export function preparePromptMessages(
  messages: Message[],
  opts?: PromptPrepareOptions,
): Message[] {
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
