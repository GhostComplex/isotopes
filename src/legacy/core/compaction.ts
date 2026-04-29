// src/core/compaction.ts — Compaction config resolution
//
// Most compaction logic is now handled by the SDK's AgentSession.
// This module only keeps isotopes-specific config resolution
// (off/safeguard/aggressive modes).

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens as sdkEstimateTokens } from "@mariozechner/pi-coding-agent";
import type { CompactionConfig, CompactionMode } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_RESERVE_TOKENS = 20_000;

const DEFAULT_THRESHOLDS: Record<CompactionMode, number> = {
  off: 1,
  safeguard: 0.8,
  aggressive: 0.5,
};

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
    reserveTokens: config?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
  };
}
