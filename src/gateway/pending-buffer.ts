import type { Message } from "./types.js";

export class PendingBuffer {
  private byKey = new Map<string, Message[]>();

  add(sessionId: string, msg: Message): number {
    const list = this.byKey.get(sessionId) ?? [];
    list.push(msg);
    this.byKey.set(sessionId, list);
    return list.length;
  }

  drain(sessionId: string): Message[] {
    const list = this.byKey.get(sessionId);
    this.byKey.delete(sessionId);
    return list ?? [];
  }

  count(sessionId: string): number {
    return this.byKey.get(sessionId)?.length ?? 0;
  }
}
