import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { EventFilter, EventHandler, Unsubscribe } from "./types.js";

interface Subscriber {
  filter: EventFilter;
  handler: EventHandler;
}

export class EventBus {
  private subscribers = new Set<Subscriber>();

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const sub: Subscriber = { filter, handler };
    this.subscribers.add(sub);
    return () => { this.subscribers.delete(sub); };
  }

  emit(sessionId: string, agentId: string, event: AgentEvent): void {
    for (const sub of this.subscribers) {
      if (sub.filter.sessionId !== undefined && sub.filter.sessionId !== sessionId) continue;
      if (sub.filter.agentId !== undefined && sub.filter.agentId !== agentId) continue;
      try { sub.handler(event); } catch { /* one bad handler must not break others */ }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}
