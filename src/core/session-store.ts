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
} from "./types.js";

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

/**
 * DefaultSessionStore — in-memory session storage with file persistence.
 *
 * Sessions are kept in memory for fast access. Message history is
 * persisted to disk as JSONL files for recovery.
 */
export class DefaultSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private keyIndex = new Map<string, string>(); // key -> sessionId
  private config: Required<SessionStoreConfig>;

  constructor(config: SessionStoreConfig) {
    this.config = {
      dataDir: config.dataDir,
      maxSessions: config.maxSessions ?? 100,
      maxTotalSizeMB: config.maxTotalSizeMB ?? 100,
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

    // Append message to JSONL file
    await this.appendMessage(sessionId, message);
    await this.persistIndex();
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    await this.ensureMessagesLoaded(session);
    return [...session.messages!];
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
    } catch {
      // Ignore if doesn't exist
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
    } catch {
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
    } catch {
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
