// src/core/session-store.ts — Session persistence and message history
// Stores sessions in memory with optional file-based persistence.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Message,
  Session,
  SessionMetadata,
  SessionStore,
  SessionStoreConfig,
  SessionConfig,
} from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("session-store");

interface StoredSession extends Session {
  messages?: Message[];
  messagesLoaded: boolean;
}

interface PersistedSessionRecord {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  lastActiveAt: string;
}

interface PersistedSessionIndex {
  sessions: Record<string, PersistedSessionRecord>;
  keyIndex?: Record<string, string>;
}

interface PersistedTranscriptRecord {
  type: "message";
  timestamp: number;
  message: Message;
}

/** Default session TTL: 24 hours in seconds */
const DEFAULT_TTL_SECONDS = 86_400;
/** Default cleanup interval: 1 hour in seconds */
const DEFAULT_CLEANUP_INTERVAL_SECONDS = 3_600;

/**
 * DefaultSessionStore — in-memory {@link SessionStore} with file persistence.
 *
 * Sessions are kept in memory for fast access. Message histories are
 * persisted to disk as JSONL files. Supports automatic TTL-based cleanup
 * of expired sessions.
 */
export class DefaultSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private keyIndex = new Map<string, string>(); // key -> sessionId
  private config: Required<SessionStoreConfig>;
  private sessionConfig: Required<SessionConfig>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce interval for index persistence on addMessage (ms) */
  private static readonly INDEX_DEBOUNCE_MS = 1_000;

  constructor(config: SessionStoreConfig) {
    this.config = {
      dataDir: config.dataDir,
      maxSessions: config.maxSessions ?? 100,
      maxTotalSizeMB: config.maxTotalSizeMB ?? 100,
      session: config.session ?? {},
    };
    this.sessionConfig = {
      ttl: config.session?.ttl ?? DEFAULT_TTL_SECONDS,
      cleanupInterval: config.session?.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL_SECONDS,
    };
  }

  /**
   * Initialize the store — create data directory and load existing sessions.
   * Call this before using the store.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await this.loadAllSessions();
  }

  async create(agentId: string, metadata?: SessionMetadata): Promise<Session> {
    // Check key uniqueness
    if (metadata?.key && this.keyIndex.has(metadata.key)) {
      throw new Error(`Session with key already exists: ${metadata.key}`);
    }

    const id = randomUUID();
    const session: StoredSession = {
      id,
      agentId,
      metadata,
      lastActiveAt: new Date(),
      messages: [],
      messagesLoaded: true,
    };

    this.sessions.set(id, session);

    // Index by key if provided
    if (metadata?.key) {
      this.keyIndex.set(metadata.key, id);
    }

    await this.persistIndex();

    return this.toSession(session);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      return undefined;
    }
    return this.toSession(stored);
  }

  async findByKey(key: string): Promise<Session | undefined> {
    const sessionId = this.keyIndex.get(key);
    if (!sessionId) {
      return undefined;
    }
    return this.get(sessionId);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    await this.ensureMessagesLoaded(session);

    session.messages!.push(message);
    session.lastActiveAt = new Date();

    // Append message to JSONL file (critical path — always await)
    await this.appendMessage(sessionId, message);

    // Index persistence is non-critical here (only updates lastActiveAt);
    // the message itself is already durable in the JSONL file.
    // Use debounced write to avoid excessive I/O on rapid message bursts.
    this.debouncedPersistIndex();
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    await this.ensureMessagesLoaded(session);
    return [...session.messages!];
  }

  async list(): Promise<Session[]> {
    return [...this.sessions.values()].map((s) => this.toSession(s));
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.metadata?.key) {
      this.keyIndex.delete(session.metadata.key);
    }
    this.sessions.delete(sessionId);

    await this.persistIndex();

    // Remove persisted files
    try {
      await fs.rm(this.transcriptFile(sessionId), { force: true });
    } catch (err) {
      log.debug(`Could not remove transcript file for session ${sessionId}`, err);
    }
  }

  // -------------------------------------------------------------------------
  // TTL & cleanup
  // -------------------------------------------------------------------------

  /**
   * Get the age of a session in seconds (time since lastActiveAt).
   * Returns undefined if the session does not exist.
   */
  getSessionAge(sessionId: string): number | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return (Date.now() - session.lastActiveAt.getTime()) / 1_000;
  }

  /**
   * Remove all sessions whose age exceeds the configured TTL.
   * Returns the IDs of deleted sessions.
   */
  async cleanupExpiredSessions(): Promise<string[]> {
    const ttl = this.sessionConfig.ttl;
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, session] of this.sessions) {
      const ageSeconds = (now - session.lastActiveAt.getTime()) / 1_000;
      if (ageSeconds > ttl) {
        expired.push(id);
      }
    }

    if (expired.length === 0) return expired;

    // Remove from in-memory maps first (avoids per-session index writes)
    for (const id of expired) {
      const session = this.sessions.get(id);
      if (session?.metadata?.key) {
        this.keyIndex.delete(session.metadata.key);
      }
      this.sessions.delete(id);
    }

    // Persist index once for the batch, then clean up transcript files in parallel
    await this.persistIndex();
    await Promise.allSettled(
      expired.map(async (id) => {
        try {
          await fs.rm(this.transcriptFile(id), { force: true });
        } catch (err) {
          log.debug(`Could not remove transcript file for session ${id}`, err);
        }
      }),
    );

    return expired;
  }

  /**
   * Start the periodic cleanup timer.
   * Runs cleanupExpiredSessions() every `cleanupInterval` seconds.
   */
  startCleanupTimer(): void {
    this.stopCleanupTimer();
    const intervalMs = this.sessionConfig.cleanupInterval * 1_000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, intervalMs);
    // Allow the Node.js process to exit even if the timer is active
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the periodic cleanup timer.
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Tear down the store: stop cleanup timer and release resources.
   */
  destroy(): void {
    this.stopCleanupTimer();
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer);
      this.indexDebounceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  private indexFile(): string {
    return path.join(this.config.dataDir, "sessions.json");
  }

  private transcriptFile(sessionId: string): string {
    return path.join(this.config.dataDir, `${sessionId}.jsonl`);
  }

  private async persistIndex(): Promise<void> {
    const index: PersistedSessionIndex = {
      sessions: Object.fromEntries(
        [...this.sessions.values()].map((session) => [
          session.id,
          {
            id: session.id,
            agentId: session.agentId,
            ...(session.metadata ? { metadata: session.metadata } : {}),
            lastActiveAt: session.lastActiveAt.toISOString(),
          },
        ]),
      ),
      keyIndex: Object.fromEntries(this.keyIndex),
    };

    await fs.writeFile(
      this.indexFile(),
      JSON.stringify(index, null, 2),
    );
  }

  /**
   * Debounced index persistence — coalesces rapid writes (e.g. during
   * message bursts) into a single disk write.
   */
  private debouncedPersistIndex(): void {
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer);
    }
    this.indexDebounceTimer = setTimeout(() => {
      this.indexDebounceTimer = null;
      void this.persistIndex();
    }, DefaultSessionStore.INDEX_DEBOUNCE_MS);
  }

  private async appendMessage(sessionId: string, message: Message): Promise<void> {
    const file = this.transcriptFile(sessionId);
    const record: PersistedTranscriptRecord = {
      type: "message",
      timestamp: message.timestamp ?? Date.now(),
      message,
    };
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(file, line);
  }

  private async ensureMessagesLoaded(session: StoredSession): Promise<void> {
    if (session.messagesLoaded) {
      return;
    }

    session.messages = await this.loadMessages(session.id);
    session.messagesLoaded = true;
  }

  private async loadMessages(sessionId: string): Promise<Message[]> {
    try {
      const content = await fs.readFile(this.transcriptFile(sessionId), "utf-8");
      const messages: Message[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const record = JSON.parse(line) as PersistedTranscriptRecord;
        if (record.type !== "message") {
          continue;
        }
        messages.push({
          ...record.message,
          timestamp: record.timestamp,
        });
      }
      return messages;
    } catch (err) {
      log.debug(`Could not load messages for session ${sessionId}`, err);
      return [];
    }
  }

  private toStoredSession(meta: PersistedSessionRecord): StoredSession {
    return {
      id: meta.id,
      agentId: meta.agentId,
      metadata: meta.metadata,
      lastActiveAt: new Date(meta.lastActiveAt),
      messagesLoaded: false,
    };
  }

  private async loadIndexFile(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexFile(), "utf-8");
    } catch (err) {
      log.debug("No session index found (first run or empty store)", err);
      return;
    }

    const index = JSON.parse(raw) as PersistedSessionIndex;
    const sessions = index.sessions ?? {};
    for (const meta of Object.values(sessions)) {
      const session = this.toStoredSession(meta);
      this.sessions.set(session.id, session);
      if (session.metadata?.key) {
        this.keyIndex.set(session.metadata.key, session.id);
      }
    }

    for (const [key, sessionId] of Object.entries(index.keyIndex ?? {})) {
      if (this.sessions.has(sessionId)) {
        this.keyIndex.set(key, sessionId);
      }
    }
  }


  /**
   * Load all sessions from disk on startup.
   */
  private async loadAllSessions(): Promise<void> {
    this.sessions.clear();
    this.keyIndex.clear();

    await this.loadIndexFile();
  }

  private toSession(stored: StoredSession): Session {
    return {
      id: stored.id,
      agentId: stored.agentId,
      metadata: stored.metadata,
      lastActiveAt: stored.lastActiveAt,
    };
  }
}
