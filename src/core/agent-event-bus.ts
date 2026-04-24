import type { AgentEvent } from "./types.js";

type Listener = (sessionId: string, event: AgentEvent) => void;

export class AgentEventBus {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(sessionId: string, event: AgentEvent): void {
    for (const fn of this.listeners) fn(sessionId, event);
  }
}

export const agentEventBus = new AgentEventBus();
