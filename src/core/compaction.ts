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
/** More conservative estimate for JSON/tool content which is less token-efficient */
const CHARS_PER_TOKEN_JSON = 3;
/** Safety margin multiplier applied to threshold (e.g., 0.9 means trigger 10% earlier) */
const THRESHOLD_SAFETY_MARGIN = 0.9;
/** Maximum compaction rounds to prevent infinite loops */
const MAX_COMPACTION_ROUNDS = 3;

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
 * Check if message content appears to be JSON or tool-related content.
 * These are less token-efficient and need more conservative estimation.
 */
function isJsonLikeContent(content: string): boolean {
  const trimmed = content.trim();
  // Check for JSON object/array patterns or common tool result patterns
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    trimmed.includes('"type":') ||
    trimmed.includes('"output":') ||
    trimmed.includes('"result":')
  );
}

/**
 * Estimate the token count of a single AgentMessage.
 * Uses a rough heuristic: 4 characters ≈ 1 token for plain text,
 * 3 characters ≈ 1 token for JSON/tool content (more conservative).
 */
export function estimateMessageTokens(message: AgentMessage): number {
  const content = extractMessageText(message);
  const charsPerToken = isJsonLikeContent(content) ? CHARS_PER_TOKEN_JSON : CHARS_PER_TOKEN;
  return Math.ceil(content.length / charsPerToken);
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
 * Applies a safety margin to trigger compaction slightly earlier than the raw threshold.
 */
export function shouldCompact(
  messages: AgentMessage[],
  config: CompactionConfig,
): boolean {
  if (config.mode === "off") return false;

  const tokenEstimate = estimateTotalTokens(messages);
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = config.threshold ?? DEFAULT_THRESHOLDS[config.mode];
  // Apply safety margin to trigger compaction earlier
  const effectiveThreshold = threshold * THRESHOLD_SAFETY_MARGIN;
  const limit = Math.floor(contextWindow * effectiveThreshold);

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

// ---------------------------------------------------------------------------
// Overflow detection
// ---------------------------------------------------------------------------

/**
 * Regex patterns to detect context overflow errors from different providers.
 * Based on patterns from @mariozechner/pi-ai/utils/overflow.
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,                            // Anthropic
  /input is too long for requested model/i,         // Amazon Bedrock
  /exceeds the context window/i,                    // OpenAI
  /input token count.*exceeds the maximum/i,        // Google (Gemini)
  /maximum prompt length is \d+/i,                  // xAI (Grok)
  /reduce the length of the messages/i,             // Groq
  /maximum context length is \d+ tokens/i,          // OpenRouter
  /exceeds the limit of \d+/i,                      // GitHub Copilot
  /exceeds the available context size/i,            // llama.cpp server
  /greater than the context length/i,               // LM Studio
  /context window exceeds limit/i,                  // MiniMax
  /exceeded model token limit/i,                    // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i,                 // z.ai
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /context[_ ]length[_ ]exceeded/i,                 // Generic fallback
  /too many tokens/i,                               // Generic fallback
  /token limit exceeded/i,                          // Generic fallback
];

/**
 * Check if an error message indicates a context overflow error.
 * This is used to detect when we need to force compaction and retry.
 */
export function isContextOverflow(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;

  // Check known patterns
  if (OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) {
    return true;
  }

  // Cerebras returns 400/413 with no body for context overflow
  if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorMessage)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Force compaction (for overflow recovery)
// ---------------------------------------------------------------------------

export interface ForceCompactOptions {
  messages: AgentMessage[];
  config: CompactionConfig;
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

/**
 * Force a compaction regardless of threshold.
 * Used for overflow recovery when we must reduce context size.
 * Returns the compacted messages or throws if compaction is not possible.
 */
export async function forceCompact(
  opts: ForceCompactOptions,
): Promise<AgentMessage[]> {
  const { messages, config, summarize, signal } = opts;

  const preserveRecent = config.preserveRecent ?? DEFAULT_PRESERVE_RECENT;

  // Can't compact if we don't have enough messages
  if (messages.length <= preserveRecent) {
    log.warn(
      `Cannot force compact: only ${messages.length} messages, need more than ${preserveRecent} to compact`,
    );
    return messages;
  }

  const splitIndex = messages.length - preserveRecent;
  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  log.info(
    `Force compacting: ${messages.length} messages → summarizing ${oldMessages.length}, keeping ${recentMessages.length}`,
  );

  const tokensBefore = estimateTotalTokens(messages);

  const prompt = buildSummaryPrompt(oldMessages);
  const summaryText = await summarize(prompt, signal);

  const summaryMessage = createSummaryMessage(summaryText);
  const compacted = [summaryMessage, ...recentMessages];

  const tokensAfter = estimateTotalTokens(compacted);
  log.info(
    `Force compaction complete: ~${tokensBefore} → ~${tokensAfter} tokens (${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction)`,
  );

  return compacted;
}

// ---------------------------------------------------------------------------
// Iterative compaction (for stubborn overflow)
// ---------------------------------------------------------------------------

export interface IterativeCompactOptions {
  messages: AgentMessage[];
  config: CompactionConfig;
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  /** Maximum number of compaction rounds. Default: 3 */
  maxRounds?: number;
}

/**
 * Perform iterative compaction until under threshold or max rounds reached.
 * This is more aggressive than regular compaction - it will keep compacting
 * until the context is small enough.
 */
export async function iterativeCompact(
  opts: IterativeCompactOptions,
): Promise<AgentMessage[]> {
  const { config, summarize, signal, maxRounds = MAX_COMPACTION_ROUNDS } = opts;
  let { messages } = opts;

  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = config.threshold ?? DEFAULT_THRESHOLDS[config.mode];
  const limit = Math.floor(contextWindow * threshold);
  const preserveRecent = config.preserveRecent ?? DEFAULT_PRESERVE_RECENT;

  for (let round = 1; round <= maxRounds; round++) {
    const tokenEstimate = estimateTotalTokens(messages);

    if (tokenEstimate <= limit) {
      log.info(`Iterative compaction complete after ${round - 1} round(s): ~${tokenEstimate} tokens`);
      return messages;
    }

    // Can't compact further if we're at minimum message count
    if (messages.length <= preserveRecent) {
      log.warn(
        `Cannot compact further: only ${messages.length} messages remain, ~${tokenEstimate} tokens still over limit`,
      );
      return messages;
    }

    log.info(
      `Iterative compaction round ${round}/${maxRounds}: ~${tokenEstimate} tokens > ${limit} limit`,
    );

    try {
      messages = await forceCompact({
        messages,
        config,
        summarize,
        signal,
      });
    } catch (err) {
      log.error(`Iterative compaction round ${round} failed`, err);
      return messages;
    }
  }

  const finalTokens = estimateTotalTokens(messages);
  log.warn(
    `Iterative compaction reached max rounds (${maxRounds}): ~${finalTokens} tokens`,
  );

  return messages;
}
