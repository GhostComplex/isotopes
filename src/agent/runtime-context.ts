import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-turn runtime context propagated through the async chain so that
 * deep tool implementations can read parent state without threading it
 * through SDK-fixed function signatures.
 *
 * Currently the only consumer is `spawn_agent` (src/agent/tools/index.ts),
 * which reads `parentSessionId` to populate `RunRequest.parentSessionId`
 * — that field is in turn used by `AgentRuntime` for spawn-tree depth
 * limits, sibling concurrency limits, and the parent-reuse session
 * policy (see `runtime.ts:computeDepth` / `countActiveSiblings`).
 *
 * Setter: `runAgent()` in `runtime-adapter.ts` wraps the per-turn
 * stream iteration so any tool call inside the turn sees the context.
 *
 * Known limitation: `spawn_agent` does not re-wrap its inner
 * `runtime.run()` loop, so nested spawns (grandchild calls) inherit
 * the root's `parentSessionId` rather than their immediate parent's.
 * Tracked separately.
 */
export interface RuntimeContext {
  /** Session id of the parent turn — the session that triggered the
   * current agent loop. */
  parentSessionId: string;
}

const storage = new AsyncLocalStorage<RuntimeContext>();

export function runWithRuntimeContext<T>(ctx: RuntimeContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRuntimeContext(): RuntimeContext | undefined {
  return storage.getStore();
}
