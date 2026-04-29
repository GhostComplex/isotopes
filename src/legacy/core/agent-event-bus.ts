import type { AgentEvent } from "./types.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("event-bus");

type Listener = (event: AgentEvent) => void;

export class SessionEventEmitter {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn("Event listener threw", err);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}

export class AgentEventBus {
  private sessions = new Map<string, SessionEventEmitter>();

  session(sessionId: string): SessionEventEmitter {
    let emitter = this.sessions.get(sessionId);
    if (!emitter) {
      emitter = new SessionEventEmitter();
      this.sessions.set(sessionId, emitter);
    }
    return emitter;
  }

  removeSession(sessionId: string): void {
    const emitter = this.sessions.get(sessionId);
    if (emitter) {
      emitter.removeAll();
      this.sessions.delete(sessionId);
    }
  }
}

export const agentEventBus = new AgentEventBus();
