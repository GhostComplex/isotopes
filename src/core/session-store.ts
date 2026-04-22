// src/core/session-store.ts — Session persistence backed by pi-coding-agent SessionManager
// Each session maps to one SessionManager (one JSONL file).
// Multi-session indexing and metadata managed locally via sessions.json.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  Message,
  Session,
  SessionMetadata,
  SessionStore,
  SessionStoreConfig,
  SessionConfig,
} from "./types.js";
import { toPiMessage, fromAgentMessage } from "./message-convert.js";
import { createLogger } from "./logger.js";

const log = createLogger("session-store");

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

interface StoredSession extends Session {
  manager?: SessionManager;
  managerLoaded: boolean;
}

const DEFAULT_TTL_SECONDS = 86_400;
const DEFAULT_CLEANUP_INTERVAL_SECONDS = 3_600;

export class DefaultSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private keyIndex = new Map<string, string>();
  private config: Required<SessionStoreConfig>;
  private sessionConfig: Required<SessionConfig>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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

  async init(): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await this.loadAllSessions();
  }

  async create(agentId: string, metadata?: SessionMetadata): Promise<Session> {
    if (metadata?.key && this.keyIndex.has(metadata.key)) {
      throw new Error(`Session with key already exists: ${metadata.key}`);
    }

    const id = randomUUID();
    const sessionFile = this.transcriptFile(id);

    // Create the SessionManager with a new JSONL file
    const manager = SessionManager.open(sessionFile);

    const session: StoredSession = {
      id,
      agentId,
      metadata,
      lastActiveAt: new Date(),
      manager,
      managerLoaded: true,
    };

    this.sessions.set(id, session);
    if (metadata?.key) {
      this.keyIndex.set(metadata.key, id);
    }

    await this.persistIndex();
    return this.toSession(session);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const stored = this.sessions.get(sessionId);
    if (!stored) return undefined;
    return this.toSession(stored);
  }

  async findByKey(key: string): Promise<Session | undefined> {
    const sessionId = this.keyIndex.get(key);
    if (!sessionId) return undefined;
    return this.get(sessionId);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    await this.ensureManagerLoaded(session);
    session.manager!.appendMessage(toPiMessage(message));
    session.lastActiveAt = new Date();

    this.debouncedPersistIndex();
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    await this.ensureManagerLoaded(session);
    const entries = session.manager!.getBranch();
    const messages: Message[] = [];
    for (const entry of entries) {
      if (entry.type === "message" && entry.message) {
        messages.push(fromAgentMessage(entry.message));
      }
    }
    return messages;
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

    try {
      await fs.rm(this.transcriptFile(sessionId), { force: true });
    } catch (err) {
      log.debug(`Could not remove transcript file for session ${sessionId}`, err);
    }
  }

  async clearMessages(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    session.lastActiveAt = new Date();
    // Truncate the file and create a fresh SessionManager
    await fs.writeFile(this.transcriptFile(sessionId), "");
    session.manager = SessionManager.open(this.transcriptFile(sessionId));
    session.managerLoaded = true;

    await this.persistIndex();
  }

  async setMessages(sessionId: string, messages: Message[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    session.lastActiveAt = new Date();
    // Rewrite the file: truncate and re-append all messages
    await fs.writeFile(this.transcriptFile(sessionId), "");
    const manager = SessionManager.open(this.transcriptFile(sessionId));
    for (const msg of messages) {
      manager.appendMessage(toPiMessage(msg));
    }
    session.manager = manager;
    session.managerLoaded = true;

    this.debouncedPersistIndex();
  }

  async setMetadata(sessionId: string, patch: Partial<SessionMetadata>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const prevKey = session.metadata?.key;
    const merged = { ...(session.metadata ?? {}), ...patch } as SessionMetadata;

    if (prevKey && prevKey !== merged.key) {
      this.keyIndex.delete(prevKey);
    }
    if (merged.key && merged.key !== prevKey) {
      const existing = this.keyIndex.get(merged.key);
      if (existing && existing !== sessionId) {
        throw new Error(`Session with key already exists: ${merged.key}`);
      }
      this.keyIndex.set(merged.key, sessionId);
    }

    session.metadata = merged;
    await this.persistIndex();
  }

  // -------------------------------------------------------------------------
  // TTL & cleanup
  // -------------------------------------------------------------------------

  getSessionAge(sessionId: string): number | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return (Date.now() - session.lastActiveAt.getTime()) / 1_000;
  }

  async cleanupExpiredSessions(): Promise<string[]> {
    const ttl = this.sessionConfig.ttl;
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.metadata?.persistent) continue;
      const ageSeconds = (now - session.lastActiveAt.getTime()) / 1_000;
      if (ageSeconds > ttl) expired.push(id);
    }

    if (expired.length === 0) return expired;

    for (const id of expired) {
      const session = this.sessions.get(id);
      if (session?.metadata?.key) this.keyIndex.delete(session.metadata.key);
      this.sessions.delete(id);
    }

    await this.persistIndex();
    await Promise.allSettled(
      expired.map(async (id) => {
        try { await fs.rm(this.transcriptFile(id), { force: true }); } catch { /* ignore */ }
      }),
    );

    return expired;
  }

  startCleanupTimer(): void {
    this.stopCleanupTimer();
    const intervalMs = this.sessionConfig.cleanupInterval * 1_000;
    this.cleanupTimer = setInterval(() => { void this.cleanupExpiredSessions(); }, intervalMs);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  destroy(): void {
    this.stopCleanupTimer();
    if (this.indexDebounceTimer) { clearTimeout(this.indexDebounceTimer); this.indexDebounceTimer = null; }
  }

  /** Expose the underlying SessionManager for a session (for compaction wiring). */
  getSessionManager(sessionId: string): SessionManager | undefined {
    return this.sessions.get(sessionId)?.manager;
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
    await fs.writeFile(this.indexFile(), JSON.stringify(index, null, 2));
  }

  private debouncedPersistIndex(): void {
    if (this.indexDebounceTimer) clearTimeout(this.indexDebounceTimer);
    this.indexDebounceTimer = setTimeout(() => {
      this.indexDebounceTimer = null;
      void this.persistIndex();
    }, DefaultSessionStore.INDEX_DEBOUNCE_MS);
  }

  private async ensureManagerLoaded(session: StoredSession): Promise<void> {
    if (session.managerLoaded && session.manager) return;
    session.manager = SessionManager.open(this.transcriptFile(session.id));
    session.managerLoaded = true;
  }

  private async loadAllSessions(): Promise<void> {
    this.sessions.clear();
    this.keyIndex.clear();

    // Load index
    try {
      const raw = await fs.readFile(this.indexFile(), "utf-8");
      const index = JSON.parse(raw) as PersistedSessionIndex;
      for (const meta of Object.values(index.sessions ?? {})) {
        const session: StoredSession = {
          id: meta.id,
          agentId: meta.agentId,
          metadata: meta.metadata,
          lastActiveAt: new Date(meta.lastActiveAt),
          managerLoaded: false,
        };
        this.sessions.set(session.id, session);
        if (session.metadata?.key) this.keyIndex.set(session.metadata.key, session.id);
      }
      for (const [key, sessionId] of Object.entries(index.keyIndex ?? {})) {
        if (this.sessions.has(sessionId)) this.keyIndex.set(key, sessionId);
      }
    } catch {
      log.debug("No session index found (first run or empty store)");
    }

    // Recover orphan JSONL files
    const countBefore = this.sessions.size;
    try {
      const files = await fs.readdir(this.config.dataDir);
      for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
        const id = file.replace(".jsonl", "");
        if (this.sessions.has(id)) continue;

        try {
          const manager = SessionManager.open(this.transcriptFile(id));
          const entries = manager.getBranch();
          if (entries.length === 0) continue;

          // Extract metadata from first message if available
          const firstMsg = entries.find((e) => e.type === "message");
          const messages = entries.filter((e) => e.type === "message");
          const lastEntry = entries[entries.length - 1];
          const lastTimestamp = lastEntry && "timestamp" in lastEntry && typeof lastEntry.timestamp === "string"
            ? new Date(lastEntry.timestamp) : new Date();

          let agentId = "unknown";
          let metadata: SessionMetadata | undefined;
          if (firstMsg && "message" in firstMsg) {
            const msg = fromAgentMessage(firstMsg.message);
            if (typeof msg.metadata?.agentId === "string") agentId = msg.metadata.agentId;
            if (msg.metadata?.sessionMetadata) metadata = msg.metadata.sessionMetadata as SessionMetadata;
          }

          const session: StoredSession = {
            id,
            agentId,
            metadata,
            lastActiveAt: lastTimestamp,
            manager,
            managerLoaded: true,
          };
          this.sessions.set(id, session);
          log.info(`Recovered orphan session: ${id} (${messages.length} messages)`);
        } catch {
          log.debug(`Could not recover orphan session ${id}`);
        }
      }
    } catch {
      log.debug("Could not scan for orphan transcripts");
    }

    if (this.sessions.size > countBefore) await this.persistIndex();
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
