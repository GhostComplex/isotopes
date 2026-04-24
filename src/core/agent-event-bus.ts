import type { AgentEvent } from "./types.js";

type Listener = (event: AgentEvent) => void;

export class AgentEventBus {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const fn of this.listeners) fn(event);
  }
}
