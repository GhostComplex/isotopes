import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Session, SessionStore, SessionMetadata } from "../core/types.js";
import { randomUUID } from "node:crypto";

export function createInMemorySessionStore(): { store: SessionStore; sessionId: string } {
  const sessionId = randomUUID();
  const manager = SessionManager.inMemory();
  const messages: AgentMessage[] = [];
  const session: Session = { id: sessionId, agentId: "tui", lastActiveAt: new Date() };

  const store: SessionStore = {
    create: async () => session,
    get: async (id) => id === sessionId ? session : undefined,
    findByKey: async () => undefined,
    addMessage: async (_id, msg) => { messages.push(msg); },
    getMessages: async () => [...messages],
    delete: async () => {},
    list: async () => [session],
    clearMessages: async () => { messages.length = 0; },
    setMessages: async (_id, msgs) => { messages.length = 0; messages.push(...msgs); },
    setMetadata: async (_id, patch) => { session.metadata = { ...session.metadata, ...patch } as SessionMetadata; },
    getSessionManager: async (id) => id === sessionId ? manager : undefined,
  };

  return { store, sessionId };
}
