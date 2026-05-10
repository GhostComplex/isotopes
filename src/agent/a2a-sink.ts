import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

/** Channel-side consumer of an A2A sub-run's AgentEvent stream. */
export interface A2ASink {
  /** Surface this run (open thread / allocate placeholder / etc.). */
  start(info: A2ASinkStartInfo): Promise<A2ASinkStartResult>;
  /** One AgentEvent. */
  send(event: AgentEvent): Promise<void>;
  /** Run finished — sink may post a status line and release resources. */
  finish(summary: A2ASinkSummary): Promise<void>;
}

export interface A2ASinkStartInfo {
  sessionId: string;
  /** Human-readable label (used as thread title, placeholder text, etc.). */
  label: string;
}

export type A2ASinkStartResult =
  | { status: "ok"; surfaceId: string }
  | { status: "error"; error: string };

export interface A2ASinkSummary {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

/**
 * Factory because sessionId is only known when runtime.run starts — sinks are
 * allocated per-spawn from whatever channel is currently driving the parent.
 */
export type A2ASinkFactory = () => A2ASink;

const storage = new AsyncLocalStorage<A2ASinkFactory>();

export function runWithA2A<T>(factory: A2ASinkFactory, fn: () => T): T {
  return storage.run(factory, fn);
}

export function getA2ASinkFactory(): A2ASinkFactory | undefined {
  return storage.getStore();
}
