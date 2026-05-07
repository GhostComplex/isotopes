import { AsyncLocalStorage } from "node:async_hooks";

// Per-turn ALS so spawn_agent can read parentSessionId at tool-call time
// without threading it through SDK-fixed execute() signatures.
export interface RuntimeContext {
  parentSessionId: string;
}

const storage = new AsyncLocalStorage<RuntimeContext>();

export function runWithRuntimeContext<T>(ctx: RuntimeContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRuntimeContext(): RuntimeContext | undefined {
  return storage.getStore();
}
