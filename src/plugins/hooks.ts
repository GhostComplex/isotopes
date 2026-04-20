// src/plugins/hooks.ts — Typed hook registry for plugin lifecycle events

import type { HookName, HookPayloads } from "./types.js";
import { createLogger } from "../core/logger.js";

type HookHandler<H extends HookName> = (payload: HookPayloads[H]) => void | Promise<void>;

const log = createLogger("plugins:hooks");

export class HookRegistry {
  private handlers = new Map<HookName, Array<HookHandler<HookName>>>();

  on<H extends HookName>(hook: H, handler: HookHandler<H>): () => void {
    const list = this.handlers.get(hook) ?? [];
    list.push(handler as HookHandler<HookName>);
    this.handlers.set(hook, list);
    return () => {
      const idx = list.indexOf(handler as HookHandler<HookName>);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async emit<H extends HookName>(hook: H, payload: HookPayloads[H]): Promise<void> {
    const list = this.handlers.get(hook);
    if (!list) return;
    for (const handler of list) {
      try {
        await handler(payload);
      } catch (err) {
        log.error(`Hook "${hook}" handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
