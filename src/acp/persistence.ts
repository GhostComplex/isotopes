// src/acp/persistence.ts — ACP session persistence to disk (#195)
// Persists ACP sessions as a JSON index + per-session JSONL message transcripts.

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../core/logger.js";
import type {
  AcpMessage,
  AcpPersistenceConfig,
  AcpSession,
  AcpSessionStatus,
} from "./types.js";

const log = createLogger("acp-persistence");

// ---------------------------------------------------------------------------
// Persisted record types
// ---------------------------------------------------------------------------

interface PersistedSessionRecord {
  id: string;
  agentId: string;
  threadId?: string;
  status: AcpSessionStatus;
  createdAt: string; // ISO 8601
  lastActivityAt: string; // ISO 8601
}

interface PersistedSessionIndex {
  sessions: Record<string, PersistedSessionRecord>;
  threadIndex: Record<string, string>; // threadId → sessionId
}

interface PersistedMessageRecord {
  type: "message";
  role: AcpMessage["role"];
  content: string;
  timestamp: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce interval for index writes triggered by addMessage (ms) */
const INDEX_DEBOUNCE_MS = 1_000;

// ---------------------------------------------------------------------------
// AcpSessionPersistence
// ---------------------------------------------------------------------------

/**
 * AcpSessionPersistence — durable storage layer for ACP sessions.
 *
 * Layout on disk:
 * - `{dataDir}/acp-sessions.json`  — session index (metadata + thread index)
 * - `{dataDir}/{sessionId}.jsonl`  — per-session message transcript
 *
 * Follows the same patterns as DefaultSessionStore:
 * - Atomic index rewrites on session create/update/terminate
 * - Append-only JSONL for message transcripts
 * - Debounced index persistence on message additions
 * - Lazy message loading from transcripts
 * - TTL-based stale session cleanup
 */
export class AcpSessionPersistence {
  private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: AcpPersistenceConfig) {}

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Create the data directory if it does not exist. */
  async init(): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Persistence — write
  // -------------------------------------------------------------------------

  /** Persist the full session index to disk. */
  async persistIndex(
    sessions: Map<string, AcpSession>,
    threadIndex: Map<string, string>,
  ): Promise<void> {
    const index: PersistedSessionIndex = {
      sessions: {},
      threadIndex: Object.fromEntries(threadIndex),
    };

    for (const [id, session] of sessions) {
      index.sessions[id] = {
        id: session.id,
        agentId: session.agentId,
        ...(session.threadId !== undefined && { threadId: session.threadId }),
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      };
    }

    await fs.writeFile(this.indexFile(), JSON.stringify(index, null, 2));
  }

  /**
   * Debounced index persistence — coalesces rapid writes (e.g. during
   * message bursts) into a single disk write.
   */
  debouncedPersistIndex(
    sessions: Map<string, AcpSession>,
    threadIndex: Map<string, string>,
  ): void {
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer);
    }
    this.indexDebounceTimer = setTimeout(() => {
      this.indexDebounceTimer = null;
      void this.persistIndex(sessions, threadIndex);
    }, INDEX_DEBOUNCE_MS);
  }

  /** Append a message to a session's JSONL transcript file. */
  async appendMessage(sessionId: string, message: AcpMessage): Promise<void> {
    const record: PersistedMessageRecord = {
      type: "message",
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
    };
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(this.transcriptFile(sessionId), line);
  }

  // -------------------------------------------------------------------------
  // Persistence — read
  // -------------------------------------------------------------------------

  /**
   * Load all persisted sessions from the index file.
   * Returns the sessions map and thread index, or empty maps if no index exists.
   * Message histories are NOT loaded — use loadMessages() for lazy loading.
   */
  async loadAll(): Promise<{
    sessions: Map<string, AcpSession>;
    threadIndex: Map<string, string>;
  }> {
    const sessions = new Map<string, AcpSession>();
    const threadIndex = new Map<string, string>();

    let raw: string;
    try {
      raw = await fs.readFile(this.indexFile(), "utf-8");
    } catch {
      log.debug("No ACP session index found (first run or empty store)");
      return { sessions, threadIndex };
    }

    let index: PersistedSessionIndex;
    try {
      index = JSON.parse(raw) as PersistedSessionIndex;
    } catch (err) {
      log.warn("Corrupted ACP session index — starting fresh", err);
      return { sessions, threadIndex };
    }

    for (const record of Object.values(index.sessions ?? {})) {
      const session: AcpSession = {
        id: record.id,
        agentId: record.agentId,
        threadId: record.threadId,
        status: record.status,
        createdAt: new Date(record.createdAt),
        lastActivityAt: new Date(record.lastActivityAt),
        history: [], // lazy-loaded
      };
      sessions.set(session.id, session);
    }

    for (const [threadId, sessionId] of Object.entries(index.threadIndex ?? {})) {
      if (sessions.has(sessionId)) {
        threadIndex.set(threadId, sessionId);
      }
    }

    log.info(`Loaded ${sessions.size} persisted ACP session(s)`);
    return { sessions, threadIndex };
  }

  /**
   * Load message history for a single session from its JSONL transcript.
   * Returns an empty array if the file does not exist or is unreadable.
   */
  async loadMessages(sessionId: string): Promise<AcpMessage[]> {
    try {
      const content = await fs.readFile(this.transcriptFile(sessionId), "utf-8");
      const messages: AcpMessage[] = [];

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as PersistedMessageRecord;
          if (record.type !== "message") continue;
          messages.push({
            role: record.role,
            content: record.content,
            timestamp: new Date(record.timestamp),
          });
        } catch {
          log.debug(`Skipping malformed transcript line in session ${sessionId}`);
        }
      }

      return messages;
    } catch {
      log.debug(`No transcript file for session ${sessionId}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Find sessions that are stale (older than TTL).
   * Terminated sessions are always considered stale.
   */
  findStaleSessions(sessions: Map<string, AcpSession>): string[] {
    const now = Date.now();
    const stale: string[] = [];

    for (const [id, session] of sessions) {
      if (session.status === "terminated") {
        stale.push(id);
        continue;
      }
      const ageSeconds = (now - session.lastActivityAt.getTime()) / 1_000;
      if (ageSeconds > this.config.ttl) {
        stale.push(id);
      }
    }

    return stale;
  }

  /** Delete the transcript file for a session. */
  async deleteTranscript(sessionId: string): Promise<void> {
    try {
      await fs.rm(this.transcriptFile(sessionId), { force: true });
    } catch (err) {
      log.debug(`Could not remove transcript for session ${sessionId}`, err);
    }
  }

  /**
   * Start the periodic cleanup timer.
   * Calls the provided cleanup function every `cleanupInterval` seconds.
   */
  startCleanupTimer(cleanupFn: () => Promise<void>): void {
    this.stopCleanupTimer();
    const intervalMs = this.config.cleanupInterval * 1_000;
    this.cleanupTimer = setInterval(() => {
      void cleanupFn();
    }, intervalMs);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Stop the periodic cleanup timer. */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Release all timers. */
  destroy(): void {
    this.stopCleanupTimer();
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer);
      this.indexDebounceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  private indexFile(): string {
    return path.join(this.config.dataDir, "acp-sessions.json");
  }

  private transcriptFile(sessionId: string): string {
    return path.join(this.config.dataDir, `${sessionId}.jsonl`);
  }
}
