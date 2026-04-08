// src/core/bindings.ts — Binding resolution for routing messages to agents
// Resolves which agent(s) should handle a message based on (channel, accountId, peer).

import type { Binding, BindingPeer } from "./types.js";

// ---------------------------------------------------------------------------
// Query — what we're trying to match against
// ---------------------------------------------------------------------------

/** Describes the source of an incoming message for binding resolution */
export interface BindingQuery {
  /** Transport channel type (e.g. "discord", "feishu") */
  channel: string;
  /** Account identifier within that channel */
  accountId?: string;
  /** Specific peer the message came from */
  peer?: BindingPeer;
}

// ---------------------------------------------------------------------------
// Specificity scoring
// ---------------------------------------------------------------------------

/**
 * Compute a specificity score for a binding.
 * Higher score = more specific match = higher priority.
 *
 * Scoring:
 *   channel only            → 1
 *   channel + accountId     → 2
 *   channel + accountId + peer → 3
 */
function specificityScore(binding: Binding): number {
  let score = 1; // channel is always present
  if (binding.match.accountId) score += 1;
  if (binding.match.peer) score += 1;
  return score;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Check if a binding matches a query */
function matches(binding: Binding, query: BindingQuery): boolean {
  const { match } = binding;

  // Channel must match
  if (match.channel !== query.channel) return false;

  // If binding specifies accountId, it must match
  if (match.accountId !== undefined) {
    if (query.accountId !== match.accountId) return false;
  }

  // If binding specifies peer, both kind and id must match
  if (match.peer !== undefined) {
    if (!query.peer) return false;
    if (match.peer.kind !== query.peer.kind) return false;
    if (match.peer.id !== query.peer.id) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve which agent should handle a message.
 *
 * Algorithm:
 *   1. Filter bindings to those that match the query
 *   2. Sort by specificity (most specific first)
 *   3. Return the most specific match, or undefined if none
 *
 * Priority order:
 *   (channel + accountId + peer) > (channel + accountId) > (channel)
 */
export function resolveBinding(
  bindings: readonly Binding[],
  query: BindingQuery,
): Binding | undefined {
  let best: Binding | undefined;
  let bestScore = -1;

  for (const binding of bindings) {
    if (!matches(binding, query)) continue;

    const score = specificityScore(binding);
    if (score > bestScore) {
      best = binding;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Resolve ALL matching bindings, sorted by specificity (most specific first).
 * Useful when multiple agents can be bound to the same route.
 */
export function resolveAllBindings(
  bindings: readonly Binding[],
  query: BindingQuery,
): Binding[] {
  return bindings
    .filter((b) => matches(b, query))
    .sort((a, b) => specificityScore(b) - specificityScore(a));
}
