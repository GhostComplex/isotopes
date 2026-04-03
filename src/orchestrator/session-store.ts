// src/orchestrator/session-store.ts — JSONL session storage with auto-cleanup

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../core/types.js';

export interface SessionMetadata {
  transport: 'discord' | 'feishu' | 'web';
  channelId?: string;
  threadId?: string;
}

export interface Session {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionStoreConfig {
  dataDir: string;
  maxSessions?: number;       // default: 100
  maxTotalSizeMB?: number;    // default: 100
}

export interface SessionStore {
  create(agentId: string, metadata?: SessionMetadata): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  delete(sessionId: string): Promise<void>;
}

export class JsonlSessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  private sessionSizes = new Map<string, number>();
  private maxSessions: number;
  private maxTotalSizeMB: number;

  constructor(private config: SessionStoreConfig) {
    this.maxSessions = config.maxSessions ?? 100;
    this.maxTotalSizeMB = config.maxTotalSizeMB ?? 100;
  }

  async create(agentId: string, metadata?: SessionMetadata): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const session: Session = {
      id,
      agentId,
      metadata,
      createdAt: now,
      lastActiveAt: now,
    };

    this.sessions.set(id, session);
    this.sessionSizes.set(id, 0);

    // Ensure session directory exists
    const sessionDir = this.sessionDir(agentId);
    await fs.mkdir(sessionDir, { recursive: true });

    // Create the empty JSONL file
    await fs.writeFile(this.sessionPath(session), '');

    await this.maybeCleanup();

    return session;
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const line = JSON.stringify(message) + '\n';
    const filePath = this.sessionPath(session);
    await fs.appendFile(filePath, line);

    // Update metadata
    session.lastActiveAt = new Date().toISOString();
    this.sessions.set(sessionId, session);

    const currentSize = this.sessionSizes.get(sessionId) ?? 0;
    this.sessionSizes.set(sessionId, currentSize + Buffer.byteLength(line));

    await this.maybeCleanup();
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const filePath = this.sessionPath(session);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Message);
    } catch {
      return [];
    }
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const filePath = this.sessionPath(session);
    try {
      await fs.unlink(filePath);
    } catch {
      // File may already be gone
    }

    this.sessions.delete(sessionId);
    this.sessionSizes.delete(sessionId);
  }

  // --- Auto-cleanup (LRU eviction) ---

  private shouldCleanup(): boolean {
    if (this.sessions.size > this.maxSessions) return true;

    const totalBytes = [...this.sessionSizes.values()].reduce((a, b) => a + b, 0);
    if (totalBytes > this.maxTotalSizeMB * 1024 * 1024) return true;

    return false;
  }

  private async maybeCleanup(): Promise<void> {
    if (!this.shouldCleanup()) return;

    // Sort by lastActiveAt ascending (oldest first)
    const sorted = [...this.sessions.entries()].sort(
      (a, b) => new Date(a[1].lastActiveAt).getTime() - new Date(b[1].lastActiveAt).getTime(),
    );

    while (this.shouldCleanup() && sorted.length > 0) {
      const [oldestId] = sorted.shift()!;
      await this.delete(oldestId);
    }
  }

  // --- Path helpers ---

  private sessionDir(agentId: string): string {
    return path.join(this.config.dataDir, 'agents', agentId, 'sessions');
  }

  private sessionPath(session: Session): string {
    return path.join(this.sessionDir(session.agentId), `${session.id}.jsonl`);
  }
}
