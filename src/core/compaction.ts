// src/core/compaction.ts — Context compaction for managing context window size.
// Implements LLM-based summarization of old messages when the conversation
// approaches the context window limit.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CompactionConfig, CompactionMode } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("compaction");

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_PRESERVE_RECENT = 10;
const CHARS_PER_TOKEN = 4;

/** Default threshold ratios per mode */
const DEFAULT_THRESHOLDS: Record<CompactionMode, number> = {
  off: 1, // never triggers
  safeguard: 0.8,
  aggressive: 0.5,
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token count of a single AgentMessage.
 * Uses a rough heuristic: 4 characters ≈ 1 token.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  const content = extractMessageText(message);
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the total token count for an array of messages.
 */
export function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * Extract plaintext from an AgentMessage for token estimation.
 * Handles string content, content block arrays, and other shapes.
 */
function extractMessageText(message: AgentMessage): string {
  // AgentMessage is a union type from pi-agent-core.
  // It can be a standard Message (user/assistant/toolResult) or a custom message.
  const msg = message as unknown as Record<string, unknown>;

  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .map((block) => {
        if (typeof block.text === "string") return block.text;
        if (typeof block.output === "string") return block.output;
        if (typeof block.content === "string") return block.content;
        return JSON.stringify(block);
      })
      .join("\n");
  }

  return JSON.stringify(msg.content ?? "");
}

// ---------------------------------------------------------------------------
// Compaction config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a partial CompactionConfig into a fully-populated config with defaults.
 */
export function resolveCompactionConfig(
  config?: Partial<CompactionConfig>,
): CompactionConfig {
  const mode = config?.mode ?? "safeguard";
  return {
    mode,
    contextWindow: config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    threshold: config?.threshold ?? DEFAULT_THRESHOLDS[mode],
    preserveRecent: config?.preserveRecent ?? DEFAULT_PRESERVE_RECENT,
  };
}

// ---------------------------------------------------------------------------
// Summary prompt
// ---------------------------------------------------------------------------

/**
 * Build a summary prompt for the LLM to compress old messages.
 */
export function buildSummaryPrompt(messages: AgentMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const m = msg as unknown as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const text = extractMessageText(msg);
    lines.push(`[${role}]: ${text}`);
  }

  return [
    "Summarize the following conversation concisely. Preserve key decisions, ",
    "facts, task context, and any important information that would be needed ",
    "to continue the conversation. Do not include greetings or filler. ",
    "Write the summary in a single block of text.\n\n",
    "---\n",
    lines.join("\n"),
    "\n---",
  ].join("");
}

// ---------------------------------------------------------------------------
// Compaction check
// ---------------------------------------------------------------------------

/**
 * Determine whether compaction should be triggered based on config and message count.
 */
export function shouldCompact(
  messages: AgentMessage[],
  config: CompactionConfig,
): boolean {
  if (config.mode === "off") return false;

  const tokenEstimate = estimateTotalTokens(messages);
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = config.threshold ?? DEFAULT_THRESHOLDS[config.mode];
  const limit = Math.floor(contextWindow * threshold);

  // Need at least preserveRecent + 1 messages to have something to compact
  const preserveRecent = config.preserveRecent ?? DEFAULT_PRESERVE_RECENT;
  if (messages.length <= preserveRecent) return false;

  return tokenEstimate > limit;
}

// ---------------------------------------------------------------------------
// Create summary message
// ---------------------------------------------------------------------------

/**
 * Create a summary AgentMessage from the summary text.
 * This replaces the compacted messages in the conversation.
 */
export function createSummaryMessage(summaryText: string): AgentMessage {
  return {
    role: "user",
    content: `[Previous conversation summary]\n\n${summaryText}`,
    timestamp: Date.now(),
  } as AgentMessage;
}

// ---------------------------------------------------------------------------
// Core compaction logic
// ---------------------------------------------------------------------------

export interface CompactMessagesOptions {
  messages: AgentMessage[];
  config: CompactionConfig;
  /** Function to generate a summary of messages using the LLM */
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

/**
 * Compact messages by summarizing old ones and keeping recent ones.
 * Returns the compacted message array or the original if no compaction needed.
 */
export async function compactMessages(
  opts: CompactMessagesOptions,
): Promise<AgentMessage[]> {
  const { messages, config, summarize, signal } = opts;

  if (!shouldCompact(messages, config)) {
    return messages;
  }

  const preserveRecent = config.preserveRecent ?? DEFAULT_PRESERVE_RECENT;
  const splitIndex = messages.length - preserveRecent;

  // Messages to summarize vs. keep
  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  log.info(
    `Compacting context: ${messages.length} messages → summarizing ${oldMessages.length}, keeping ${recentMessages.length}`,
  );

  const tokensBefore = estimateTotalTokens(messages);

  try {
    const prompt = buildSummaryPrompt(oldMessages);
    const summaryText = await summarize(prompt, signal);

    const summaryMessage = createSummaryMessage(summaryText);
    const compacted = [summaryMessage, ...recentMessages];

    const tokensAfter = estimateTotalTokens(compacted);
    log.info(
      `Compaction complete: ~${tokensBefore} → ~${tokensAfter} tokens (${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction)`,
    );

    return compacted;
  } catch (err) {
    // Contract: transformContext must not throw. Return original messages on failure.
    log.error("Compaction failed, returning original messages", err);
    return messages;
  }
}

// ---------------------------------------------------------------------------
// transformContext factory — wires compaction into pi-agent-core
// ---------------------------------------------------------------------------

export interface CreateTransformContextOptions {
  config: CompactionConfig;
  /** Function to generate a summary of messages using the LLM */
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * Create a `transformContext` hook for pi-agent-core's Agent.
 * Returns undefined if compaction is disabled (mode: 'off').
 */
export function createTransformContext(
  opts: CreateTransformContextOptions,
): ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined {
  if (opts.config.mode === "off") {
    return undefined;
  }

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    return compactMessages({
      messages,
      config: opts.config,
      summarize: opts.summarize,
      signal,
    });
  };
}
