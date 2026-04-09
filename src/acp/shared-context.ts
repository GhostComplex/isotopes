// src/acp/shared-context.ts — Shared context for multi-agent collaboration
// Allows multiple sessions to share a named data context.

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A named shared context that multiple sessions can participate in. */
export interface SharedContext {
  /** Unique context identifier */
  id: string;
  /** Human-readable name for the context */
  name: string;
  /** Session IDs that have joined this context */
  participants: string[];
  /** Arbitrary shared data */
  data: Record<string, unknown>;
  /** When the context was created */
  createdAt: Date;
  /** When the context was last modified */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// SharedContextManager
// ---------------------------------------------------------------------------

/**
 * SharedContextManager — manages named shared data contexts that multiple
 * ACP sessions can participate in.
 *
 * Responsibilities:
 * - Create / get / delete contexts
 * - Join / leave participants (by sessionId)
 * - Update shared data (shallow merge)
 * - Look up contexts by session
 */
export class SharedContextManager {
  private contexts: Map<string, SharedContext> = new Map();

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new shared context with an optional initial data payload.
   */
  create(name: string, initialData?: Record<string, unknown>): SharedContext {
    const now = new Date();
    const ctx: SharedContext = {
      id: randomUUID(),
      name,
      participants: [],
      data: initialData ? { ...initialData } : {},
      createdAt: now,
      updatedAt: now,
    };
    this.contexts.set(ctx.id, ctx);
    return ctx;
  }

  /**
   * Retrieve a context by ID.
   */
  get(contextId: string): SharedContext | undefined {
    return this.contexts.get(contextId);
  }

  /**
   * Delete a context. Returns true if it existed.
   */
  delete(contextId: string): boolean {
    return this.contexts.delete(contextId);
  }

  // -------------------------------------------------------------------------
  // Participants
  // -------------------------------------------------------------------------

  /**
   * Add a session to a context's participant list.
   * Returns true if the session was added (false if already present or context not found).
   */
  join(contextId: string, sessionId: string): boolean {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return false;
    if (ctx.participants.includes(sessionId)) return false;

    ctx.participants.push(sessionId);
    ctx.updatedAt = new Date();
    return true;
  }

  /**
   * Remove a session from a context's participant list.
   * Returns true if the session was removed.
   */
  leave(contextId: string, sessionId: string): boolean {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return false;

    const idx = ctx.participants.indexOf(sessionId);
    if (idx === -1) return false;

    ctx.participants.splice(idx, 1);
    ctx.updatedAt = new Date();
    return true;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /**
   * Shallow-merge new data into the context's data object.
   * Returns the updated context, or undefined if not found.
   */
  update(contextId: string, data: Record<string, unknown>): SharedContext | undefined {
    const ctx = this.contexts.get(contextId);
    if (!ctx) return undefined;

    Object.assign(ctx.data, data);
    ctx.updatedAt = new Date();
    return ctx;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Return all contexts that a given session is a participant of.
   */
  getBySession(sessionId: string): SharedContext[] {
    const results: SharedContext[] = [];
    for (const ctx of this.contexts.values()) {
      if (ctx.participants.includes(sessionId)) {
        results.push(ctx);
      }
    }
    return results;
  }
}
