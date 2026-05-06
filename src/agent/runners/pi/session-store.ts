import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { Message as PiMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  Session,
  SessionMetadata,
  SessionStore,
  TranscriptListener,
  TranscriptUpdate,
} from "../../../sessions/types.js";
import {
  ensureAgentSessionsDir,
  normalizeAgentId,
} from "../../../paths.js";
import { createLogger } from "../../../logging/logger.js";

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

/** Cache one manager per session: pi SDK's `flushed` flag drops user-only appends on a freshly-opened file with no assistant. */
interface StoredSession extends Session {
  manager?: SessionManager;
}

function installTranscriptEmitter(
  sm: SessionManager,
  sessionId: string,
  emit: (update: TranscriptUpdate) => void,
): void {
  const original = sm.appendMessage.bind(sm);
  sm.appendMessage = (message: PiMessage) => {
    const messageId = original(message);
    try {
      // PiMessage === AgentMessage structurally; pi-agent-core re-exports both names.
      emit({ sessionId, message: message as unknown as AgentMessage, messageId });
    } catch {
      // swallow: a throw here would corrupt SDK turn state
    }
    return messageId;
  };
}

export class DefaultSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private keyIndex = new Map<string, string>();
  private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INDEX_DEBOUNCE_MS = 1_000;
  /** Transcript-bus listeners per sessionId. */
  private listeners = new Map<string, Set<TranscriptListener>>();

  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadIndex();
  }

  async create(agentId: string, metadata?: SessionMetadata): Promise<Session> {
    if (metadata?.key && this.keyIndex.has(metadata.key)) {
      throw new Error(`Session with key already exists: ${metadata.key}`);
    }
    const id = randomUUID();
    const manager = this.openPatchedManager(id);
    const session: StoredSession = { id, agentId, metadata, lastActiveAt: new Date(), manager };
    this.sessions.set(id, session);
    if (metadata?.key) this.keyIndex.set(metadata.key, id);
    await this.persistIndex();
    return toSession(session);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? toSession(s) : undefined;
  }

  async findByKey(key: string): Promise<Session | undefined> {
    const id = this.keyIndex.get(key);
    return id ? this.get(id) : undefined;
  }

  async getSessionManager(sessionId: string): Promise<SessionManager | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return this.ensureManager(session);
  }

  async addMessage(sessionId: string, message: AgentMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    this.ensureManager(session).appendMessage(message as unknown as PiMessage);
    session.lastActiveAt = new Date();
    this.debouncedPersistIndex();
  }

  async getMessages(sessionId: string): Promise<AgentMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    const entries = this.ensureManager(session).getBranch();
    const messages: AgentMessage[] = [];
    for (const entry of entries) {
      if (entry.type === "message" && entry.message) messages.push(entry.message);
    }
    return messages;
  }

  async list(): Promise<Session[]> {
    return [...this.sessions.values()].map(toSession);
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.metadata?.key) this.keyIndex.delete(session.metadata.key);
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
    await fs.writeFile(this.transcriptFile(sessionId), "");
    session.manager = this.openPatchedManager(sessionId);
    await this.persistIndex();
  }

  destroy(): void {
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer);
      this.indexDebounceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private indexFile(): string {
    return path.join(this.dataDir, "sessions.json");
  }

  private transcriptFile(sessionId: string): string {
    return path.join(this.dataDir, `${sessionId}.jsonl`);
  }

  private async persistIndex(): Promise<void> {
    const index: PersistedSessionIndex = {
      sessions: Object.fromEntries(
        [...this.sessions.values()].map((s) => [
          s.id,
          {
            id: s.id,
            agentId: s.agentId,
            ...(s.metadata ? { metadata: s.metadata } : {}),
            lastActiveAt: s.lastActiveAt.toISOString(),
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

  private async loadIndex(): Promise<void> {
    this.sessions.clear();
    this.keyIndex.clear();
    let raw: string;
    try {
      raw = await fs.readFile(this.indexFile(), "utf-8");
    } catch {
      log.debug("No session index found (first run or empty store)");
      return;
    }
    const index = JSON.parse(raw) as PersistedSessionIndex;
    for (const meta of Object.values(index.sessions ?? {})) {
      const session: StoredSession = {
        id: meta.id,
        agentId: meta.agentId,
        metadata: meta.metadata,
        lastActiveAt: new Date(meta.lastActiveAt),
      };
      this.sessions.set(session.id, session);
      if (session.metadata?.key) this.keyIndex.set(session.metadata.key, session.id);
    }
    for (const [key, sessionId] of Object.entries(index.keyIndex ?? {})) {
      if (this.sessions.has(sessionId)) this.keyIndex.set(key, sessionId);
    }
  }

  private ensureManager(session: StoredSession): SessionManager {
    if (!session.manager) {
      session.manager = this.openPatchedManager(session.id);
    }
    return session.manager;
  }

  /** Single source of truth for opening a SessionManager — patches it
   * with the transcript emitter exactly once. */
  private openPatchedManager(sessionId: string): SessionManager {
    const sm = SessionManager.open(this.transcriptFile(sessionId));
    installTranscriptEmitter(sm, sessionId, (u) => this.emitTranscript(u));
    return sm;
  }

  private emitTranscript(update: TranscriptUpdate): void {
    const set = this.listeners.get(update.sessionId);
    if (!set) return;
    for (const fn of set) {
      try { fn(update); }
      catch (err) { log.warn("Transcript listener threw", err); }
    }
  }

  /** Subscribe a transcript-bus listener. Multiple listeners per session are allowed. */
  subscribe(sessionId: string, listener: TranscriptListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }
}

function toSession(s: StoredSession): Session {
  return {
    id: s.id,
    agentId: s.agentId,
    metadata: s.metadata,
    lastActiveAt: s.lastActiveAt,
  };
}

// ---------------------------------------------------------------------------
// SessionStoreManager — one DefaultSessionStore per agentId.
// ---------------------------------------------------------------------------

const mgrLog = createLogger("session-store-manager");

export class SessionStoreManager {
  private stores = new Map<string, DefaultSessionStore>();
  private inits = new Map<string, Promise<DefaultSessionStore>>();

  /** Concurrent calls for the same agentId share one initialization. */
  async getOrCreate(agentId: string): Promise<DefaultSessionStore> {
    const key = normalizeAgentId(agentId);

    const existing = this.stores.get(key);
    if (existing) return existing;

    const pending = this.inits.get(key);
    if (pending) return pending;

    const init = (async () => {
      const dataDir = await ensureAgentSessionsDir(agentId);
      const store = new DefaultSessionStore(dataDir);
      await store.init();
      this.stores.set(key, store);
      this.inits.delete(key);
      mgrLog.debug(`Initialized session store for agent ${agentId} at ${dataDir}`);
      return store;
    })();

    this.inits.set(key, init);
    return init;
  }

  /** Sync; returns undefined if the store has not been created yet. */
  peek(agentId: string): DefaultSessionStore | undefined {
    return this.stores.get(normalizeAgentId(agentId));
  }

  all(): Map<string, DefaultSessionStore> {
    return new Map(this.stores);
  }

  destroyAll(): void {
    for (const store of this.stores.values()) {
      store.destroy();
    }
    this.stores.clear();
    this.inits.clear();
  }
}
