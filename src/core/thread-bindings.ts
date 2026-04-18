// src/core/thread-bindings.ts — Thread binding manager for Discord thread → agent session mapping
// Stores and resolves bindings between Discord threads and agent sessions.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ThreadBinding } from "./types.js";
import { logger } from "./logger.js";

/** Callback invoked when a new thread binding is created */
export type ThreadBindingCallback = (binding: ThreadBinding) => void;

/** Callback invoked when a thread binding is removed */
export type ThreadUnbindCallback = (binding: ThreadBinding, reason?: string) => void;

/**
 * ThreadBindingManager — manages the mapping of Discord threads to agent sessions.
 *
 * When a Discord thread is created in a monitored channel, the transport calls
 * `bind()` to record the association. Downstream consumers can subscribe via
 * `onBind()` or look up bindings by thread/session ID.
 */
export class ThreadBindingManager {
  private bindings: Map<string, ThreadBinding> = new Map();
  private listeners: ThreadBindingCallback[] = [];
  private unbindListeners: ThreadUnbindCallback[] = [];
  private persistPath: string | null = null;

  constructor(options?: { persistPath?: string }) {
    this.persistPath = options?.persistPath ?? null;
  }

  /**
   * Load bindings from the persist file.
   * Call this once at startup.
   *
   * @param options.clearStale - If true, clear all bindings after loading (for startup cleanup)
   */
  async load(options?: { clearStale?: boolean }): Promise<void> {
    if (!this.persistPath) return;

    try {
      const data = await readFile(this.persistPath, "utf-8");
      const serialized = JSON.parse(data) as Array<{
        threadId: string;
        parentChannelId: string;
        sessionId?: string;
        agentId: string;
        createdAt: string;
      }>;

      this.bindings.clear();
      for (const item of serialized) {
        const binding: ThreadBinding = {
          threadId: item.threadId,
          parentChannelId: item.parentChannelId,
          sessionId: item.sessionId,
          agentId: item.agentId,
          createdAt: new Date(item.createdAt),
        };
        this.bindings.set(item.threadId, binding);
      }
      logger.debug(`Loaded ${this.bindings.size} thread binding(s) from ${this.persistPath}`);

      // Clear stale bindings on startup (subagents are dead after restart)
      if (options?.clearStale && this.bindings.size > 0) {
        const staleCount = this.bindings.size;
        await this.clearAll("startup cleanup: subagents dead after restart");
        logger.info(`Cleared ${staleCount} stale thread binding(s) on startup`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet, that's fine
        return;
      }
      logger.warn(`Failed to load thread bindings: ${err}`);
    }
  }

  /**
   * Save bindings to the persist file.
   * Called automatically on bind/unbind.
   */
  private async save(): Promise<void> {
    if (!this.persistPath) return;

    try {
      const serialized = Array.from(this.bindings.values()).map((b) => ({
        threadId: b.threadId,
        parentChannelId: b.parentChannelId,
        sessionId: b.sessionId,
        agentId: b.agentId,
        createdAt: b.createdAt.toISOString(),
      }));

      await mkdir(path.dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(serialized, null, 2));
    } catch (err) {
      logger.warn(`Failed to save thread bindings: ${err}`);
    }
  }

  /**
   * Create a binding between a Discord thread and an agent.
   * If a binding already exists for the threadId, it is replaced.
   */
  bind(
    threadId: string,
    binding: Omit<ThreadBinding, "threadId" | "createdAt">,
  ): ThreadBinding {
    const full: ThreadBinding = {
      ...binding,
      threadId,
      createdAt: new Date(),
    };

    this.bindings.set(threadId, full);
    void this.save();

    for (const listener of this.listeners) {
      listener(full);
    }

    return full;
  }

  /** Retrieve a binding by thread ID */
  get(threadId: string): ThreadBinding | undefined {
    return this.bindings.get(threadId);
  }

  /** Remove a binding by thread ID. Returns true if a binding was removed. */
  unbind(threadId: string, reason?: string): boolean {
    const binding = this.bindings.get(threadId);
    if (!binding) {
      return false;
    }
    this.bindings.delete(threadId);
    void this.save();

    for (const listener of this.unbindListeners) {
      listener(binding, reason);
    }

    return true;
  }

  /** Get the total number of active bindings. */
  get size(): number {
    return this.bindings.size;
  }

  /**
   * Clear all bindings. Used for startup cleanup when subagents are dead.
   * Notifies unbind listeners for each binding.
   *
   * @param reason - Reason for clearing (for logging/debugging)
   * @returns Number of bindings cleared
   */
  async clearAll(reason?: string): Promise<number> {
    const count = this.bindings.size;

    for (const binding of this.bindings.values()) {
      for (const listener of this.unbindListeners) {
        listener(binding, reason);
      }
    }

    this.bindings.clear();
    await this.save();

    return count;
  }

  /**
   * Get all current bindings (for inspection/debugging).
   */
  all(): ThreadBinding[] {
    return Array.from(this.bindings.values());
  }

  /**
   * Register a callback that fires whenever a new thread binding is created.
   * Returns an unsubscribe function.
   */
  onBind(callback: ThreadBindingCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Register a callback that fires whenever a thread binding is removed.
   * Returns an unsubscribe function.
   */
  onUnbind(callback: ThreadUnbindCallback): () => void {
    this.unbindListeners.push(callback);
    return () => {
      const idx = this.unbindListeners.indexOf(callback);
      if (idx !== -1) this.unbindListeners.splice(idx, 1);
    };
  }
}
