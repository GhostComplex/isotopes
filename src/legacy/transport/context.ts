// src/transport/context.ts — AsyncLocalStorage for transport-injected
// per-message context. Transports wrap their inbound dispatch in
// `runWithMessageContext(...)`; downstream code (tools, runtime bookkeeping)
// reads via `getMessageContext()` without having to plumb arguments.

import { AsyncLocalStorage } from "node:async_hooks";

export interface MessageContext {
  /** Short transport tag, e.g. "discord", "http", "tui", "feishu". */
  transport: string;
  /** Opaque transport-specific channel id. */
  channelKey: string;
  /** Agent currently being invoked for this turn. */
  agentId: string;
  /** Caller's session id when invoked from inside another agent's tool. */
  parentSessionId?: string;
}

const storage = new AsyncLocalStorage<MessageContext>();

export function runWithMessageContext<T>(ctx: MessageContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getMessageContext(): MessageContext | undefined {
  return storage.getStore();
}
