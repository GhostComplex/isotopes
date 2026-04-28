// src/transport/channel-registry.ts — Tracks channel ↔ agent membership.
//
// A "channel" is an opaque, transport-specific identifier (e.g. a Discord
// channel id, a TUI session, a Feishu group). The registry only stores
// strings — it has no opinion on what a channel actually is. Transports
// register their agents into channels at bind time; the runtime/tooling
// layer queries to decide who should see a given message.

export class ChannelRegistry {
  private channels = new Map<string, Set<string>>();

  addAgent(channelKey: string, agentId: string): void {
    let set = this.channels.get(channelKey);
    if (!set) {
      set = new Set();
      this.channels.set(channelKey, set);
    }
    set.add(agentId);
  }

  removeAgent(channelKey: string, agentId: string): boolean {
    const set = this.channels.get(channelKey);
    if (!set) return false;
    const removed = set.delete(agentId);
    if (set.size === 0) this.channels.delete(channelKey);
    return removed;
  }

  getAgents(channelKey: string): string[] {
    return [...(this.channels.get(channelKey) ?? [])];
  }

  getChannels(agentId: string): string[] {
    const out: string[] = [];
    for (const [channelKey, agents] of this.channels) {
      if (agents.has(agentId)) out.push(channelKey);
    }
    return out;
  }

  has(channelKey: string, agentId: string): boolean {
    return this.channels.get(channelKey)?.has(agentId) ?? false;
  }

  clear(): void {
    this.channels.clear();
  }

  get channelCount(): number {
    return this.channels.size;
  }
}
