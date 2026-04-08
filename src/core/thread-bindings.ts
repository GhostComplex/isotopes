// src/core/thread-bindings.ts — Thread binding manager for Discord thread → agent session mapping
// Stores and resolves bindings between Discord threads and agent sessions.

import type { ThreadBinding } from "./types.js";
import type { AcpSessionManager } from "../acp/session-manager.js";

/** Callback invoked when a new thread binding is created */
export type ThreadBindingCallback = (binding: ThreadBinding) => void;

/**
 * ThreadBindingManager — manages the mapping of Discord threads to agent sessions.
 *
 * When a Discord thread is created in a monitored channel, the transport calls
 * `bind()` to record the association. Downstream consumers (M3.2 ACP session
 * spawner) can subscribe via `onBind()` or look up bindings by thread/session ID.
 *
 * When an AcpSessionManager is attached and `spawnAcpSessions` is true, creating
 * a thread binding automatically spawns an ACP session for the bound agent.
 */
export class ThreadBindingManager {
  private bindings: Map<string, ThreadBinding> = new Map();
  private listeners: ThreadBindingCallback[] = [];
  private acpSessionManager: AcpSessionManager | null = null;
  private spawnAcpSessions = false;

  /**
   * Attach an AcpSessionManager to auto-spawn ACP sessions on bind.
   * Pass `spawnAcpSessions: true` to enable automatic session creation.
   */
  attachAcpSessionManager(
    acpSessionManager: AcpSessionManager,
    options?: { spawnAcpSessions?: boolean },
  ): void {
    this.acpSessionManager = acpSessionManager;
    this.spawnAcpSessions = options?.spawnAcpSessions ?? false;
  }

  /**
   * Detach the AcpSessionManager (disables auto-spawn).
   */
  detachAcpSessionManager(): void {
    this.acpSessionManager = null;
    this.spawnAcpSessions = false;
  }

  /**
   * Create a binding between a Discord thread and an agent.
   * If a binding already exists for the threadId, it is replaced.
   *
   * When an AcpSessionManager is attached with spawnAcpSessions enabled,
   * an ACP session is automatically created and its ID stored in the binding.
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

    // Auto-spawn ACP session if configured
    if (this.acpSessionManager && this.spawnAcpSessions && !full.sessionId) {
      const session = this.acpSessionManager.createSession(full.agentId, threadId);
      full.sessionId = session.id;
    }

    this.bindings.set(threadId, full);

    // Notify listeners
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
  unbind(threadId: string): boolean {
    return this.bindings.delete(threadId);
  }

  /** Look up a binding by its session ID (reverse lookup). */
  getBySessionId(sessionId: string): ThreadBinding | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId) {
        return binding;
      }
    }
    return undefined;
  }

  /** Get the total number of active bindings. */
  get size(): number {
    return this.bindings.size;
  }

  /**
   * Register a callback that fires whenever a new thread binding is created.
   * Returns an unsubscribe function.
   */
  onBind(callback: ThreadBindingCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}
