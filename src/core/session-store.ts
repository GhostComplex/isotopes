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
  messages: Message[];
}

/**
 * DefaultSessionStore — in-memory session storage with file persistence.
 *
 * Sessions are kept in memory for fast access. Message history is
 * persisted to disk as JSONL files for recovery.
 */
export class DefaultSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private config: Required<SessionStoreConfig>;

  constructor(config: SessionStoreConfig) {
    this.config = {
      dataDir: config.dataDir,
      maxSessions: config.maxSessions ?? 100,
      maxTotalSizeMB: config.maxTotalSizeMB ?? 100,
    };
  }

  /**
   * Initialize the store — create data directory if needed.
   * Call this before using the store.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
  }

  async create(agentId: string, metadata?: SessionMetadata): Promise<Session> {
    const id = randomUUID();
    const session: StoredSession = {
      id,
      agentId,
      metadata,
      lastActiveAt: new Date(),
      messages: [],
    };

    this.sessions.set(id, session);

    // Persist session metadata
    await this.persistSession(session);

    return this.toSession(session);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      // Try loading from disk
      const loaded = await this.loadSession(sessionId);
      if (loaded) {
        this.sessions.set(sessionId, loaded);
        return this.toSession(loaded);
      }
      return undefined;
    }
    return this.toSession(stored);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    session.messages.push(message);
    session.lastActiveAt = new Date();

    // Append message to JSONL file
    await this.appendMessage(sessionId, message);
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return [...session.messages];
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);

    // Remove persisted files
    const sessionDir = path.join(this.config.dataDir, sessionId);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  private sessionDir(sessionId: string): string {
    return path.join(this.config.dataDir, sessionId);
  }

  private async persistSession(session: StoredSession): Promise<void> {
    const dir = this.sessionDir(session.id);
    await fs.mkdir(dir, { recursive: true });

    const meta = {
      id: session.id,
      agentId: session.agentId,
      metadata: session.metadata,
      createdAt: session.lastActiveAt.toISOString(),
    };

    await fs.writeFile(
      path.join(dir, "session.json"),
      JSON.stringify(meta, null, 2),
    );
  }

  private async appendMessage(sessionId: string, message: Message): Promise<void> {
    const file = path.join(this.sessionDir(sessionId), "messages.jsonl");
    const line = JSON.stringify(message) + "\n";
    await fs.appendFile(file, line);
  }

  private async loadSession(sessionId: string): Promise<StoredSession | undefined> {
    const dir = this.sessionDir(sessionId);

    try {
      const metaFile = path.join(dir, "session.json");
      const metaContent = await fs.readFile(metaFile, "utf-8");
      const meta = JSON.parse(metaContent) as {
        id: string;
        agentId: string;
        metadata?: SessionMetadata;
        createdAt: string;
      };

      // Load messages
      const messages: Message[] = [];
      const messagesFile = path.join(dir, "messages.jsonl");
      try {
        const content = await fs.readFile(messagesFile, "utf-8");
        for (const line of content.split("\n")) {
          if (line.trim()) {
            messages.push(JSON.parse(line) as Message);
          }
        }
      } catch {
        // No messages file yet
      }

      return {
        id: meta.id,
        agentId: meta.agentId,
        metadata: meta.metadata,
        lastActiveAt: new Date(meta.createdAt),
        messages,
      };
    } catch {
      return undefined;
    }
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
