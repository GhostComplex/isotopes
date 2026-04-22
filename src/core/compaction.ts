// src/core/compaction.ts — Context compaction via pi-coding-agent SDK.
// Thin wrapper that maps isotopes' CompactionConfig to the SDK's compaction
// primitives. Token estimation, cut-point logic, and LLM summarization
// all delegate to the SDK.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import {
  estimateTokens as sdkEstimateTokens,
  shouldCompact as sdkShouldCompact,
  generateSummary,
} from "@mariozechner/pi-coding-agent";
import type { CompactionConfig, CompactionMode } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("compaction");

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const MAX_COMPACTION_ROUNDS = 3;

const DEFAULT_THRESHOLDS: Record<CompactionMode, number> = {
  off: 1,
  safeguard: 0.8,
  aggressive: 0.5,
};

interface SdkCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

// ---------------------------------------------------------------------------
// Token estimation — delegate to SDK
// ---------------------------------------------------------------------------

export function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += sdkEstimateTokens(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export function resolveCompactionConfig(
  config?: Partial<CompactionConfig>,
): CompactionConfig {
  const mode = config?.mode ?? "safeguard";
  return {
    mode,
    contextWindow: config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    threshold: config?.threshold ?? DEFAULT_THRESHOLDS[mode],
    preserveRecent: config?.preserveRecent ?? 10,
  };
}

/** Map isotopes CompactionConfig to SDK CompactionSettings. */
function toSdkSettings(config: CompactionConfig): SdkCompactionSettings {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = config.threshold ?? DEFAULT_THRESHOLDS[config.mode];
  const fromThreshold = Math.floor(contextWindow * (1 - threshold));
  return {
    enabled: config.mode !== "off",
    reserveTokens: config.reserveTokens ?? Math.max(fromThreshold, DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
  } satisfies SdkCompactionSettings;
}

// ---------------------------------------------------------------------------
// Compaction check — delegate to SDK
// ---------------------------------------------------------------------------

export function shouldCompact(
  messages: AgentMessage[],
  config: CompactionConfig,
): boolean {
  if (config.mode === "off") return false;

  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextTokens = estimateTotalTokens(messages);
  const settings = toSdkSettings(config);

  return sdkShouldCompact(contextTokens, contextWindow, settings);
}

// ---------------------------------------------------------------------------
// Create summary message
// ---------------------------------------------------------------------------

export function createSummaryMessage(summaryText: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[Previous conversation summary]\n\n${summaryText}` }],
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Core compaction — delegate summarization to SDK
// ---------------------------------------------------------------------------

export interface CompactMessagesOptions {
  messages: AgentMessage[];
  config: CompactionConfig;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function compactMessages(
  opts: CompactMessagesOptions,
): Promise<AgentMessage[]> {
  const { messages, config, model, apiKey, headers, signal } = opts;

  if (!shouldCompact(messages, config)) {
    return messages;
  }

  const settings = toSdkSettings(config);
  const tokensBefore = estimateTotalTokens(messages);

  log.info(
    `Compacting context: ${messages.length} messages, ~${tokensBefore} tokens`,
  );

  try {
    const summaryText = await generateSummary(
      messages, model, settings.reserveTokens, apiKey, headers, signal,
    );

    const summaryMessage = createSummaryMessage(summaryText);
    // Keep messages that fit in keepRecentTokens budget
    const recentMessages = keepRecentByTokens(messages, settings.keepRecentTokens);
    const compacted = [summaryMessage, ...recentMessages];

    const tokensAfter = estimateTotalTokens(compacted);
    log.info(
      `Compaction complete: ~${tokensBefore} → ~${tokensAfter} tokens (${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction)`,
    );

    return compacted;
  } catch (err) {
    log.error("Compaction failed, returning original messages", err);
    return messages;
  }
}

// ---------------------------------------------------------------------------
// transformContext factory
// ---------------------------------------------------------------------------

export interface CreateTransformContextOptions {
  config: CompactionConfig;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
}

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
      model: opts.model,
      apiKey: opts.apiKey,
      headers: opts.headers,
      signal,
    });
  };
}

// ---------------------------------------------------------------------------
// Overflow detection (isotopes-specific)
// ---------------------------------------------------------------------------

const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

export function isContextOverflow(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) return true;
  if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorMessage)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Force compaction (for overflow recovery)
// ---------------------------------------------------------------------------

export interface ForceCompactOptions {
  messages: AgentMessage[];
  config: CompactionConfig;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function forceCompact(
  opts: ForceCompactOptions,
): Promise<AgentMessage[]> {
  const { messages, config, model, apiKey, headers, signal } = opts;
  const settings = toSdkSettings(config);

  if (messages.length <= 2) {
    log.warn(`Cannot force compact: only ${messages.length} messages`);
    return messages;
  }

  const tokensBefore = estimateTotalTokens(messages);
  log.info(`Force compacting: ${messages.length} messages, ~${tokensBefore} tokens`);

  const summaryText = await generateSummary(
    messages, model, settings.reserveTokens, apiKey, headers, signal,
  );

  const summaryMessage = createSummaryMessage(summaryText);
  const recentMessages = keepRecentByTokens(messages, settings.keepRecentTokens);
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
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRounds?: number;
}

export async function iterativeCompact(
  opts: IterativeCompactOptions,
): Promise<AgentMessage[]> {
  const { config, model, apiKey, headers, signal, maxRounds = MAX_COMPACTION_ROUNDS } = opts;
  let { messages } = opts;

  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const settings = toSdkSettings(config);

  for (let round = 1; round <= maxRounds; round++) {
    const tokenEstimate = estimateTotalTokens(messages);

    if (!sdkShouldCompact(tokenEstimate, contextWindow, settings)) {
      log.info(`Iterative compaction complete after ${round - 1} round(s): ~${tokenEstimate} tokens`);
      return messages;
    }

    if (messages.length <= 2) {
      log.warn(`Cannot compact further: only ${messages.length} messages, ~${tokenEstimate} tokens`);
      return messages;
    }

    log.info(`Iterative compaction round ${round}/${maxRounds}: ~${tokenEstimate} tokens`);

    try {
      messages = await forceCompact({ messages, config, model, apiKey, headers, signal });
    } catch (err) {
      log.error(`Iterative compaction round ${round} failed`, err);
      return messages;
    }
  }

  const finalTokens = estimateTotalTokens(messages);
  log.warn(`Iterative compaction reached max rounds (${maxRounds}): ~${finalTokens} tokens`);
  return messages;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Keep the most recent messages that fit within a token budget.
 * Walks backward, accumulating tokens. Cuts at a safe point (not mid tool-pair).
 */
function keepRecentByTokens(messages: AgentMessage[], tokenBudget: number): AgentMessage[] {
  let accumulated = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += sdkEstimateTokens(messages[i]);
    if (accumulated > tokenBudget) {
      cutIndex = i + 1;
      break;
    }
  }

  // Forward check: don't cut at a toolResult — walk back to include its parent
  while (cutIndex > 0 && cutIndex < messages.length) {
    const msg = messages[cutIndex] as unknown as { role?: string };
    if (msg.role === "toolResult" || msg.role === "tool_result") {
      cutIndex--;
    } else {
      break;
    }
  }

  // Backward check: if the message just before the cut is an assistant with
  // toolCall blocks, its results are in the kept portion but the call is not.
  // Move cut back to include the assistant.
  if (cutIndex > 0) {
    const prev = messages[cutIndex - 1] as unknown as { role?: string; content?: unknown[] };
    if (prev.role === "assistant" && Array.isArray(prev.content) &&
        prev.content.some((b: unknown) => {
          const block = b as { type?: string };
          return block.type === "toolCall" || block.type === "tool_call" || block.type === "tool_use";
        })) {
      cutIndex--;
    }
  }

  return messages.slice(cutIndex);
}
