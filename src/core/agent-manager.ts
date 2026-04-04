// src/core/agent-manager.ts — Agent lifecycle management
// Creates, stores, and manages AgentInstance objects.

import type {
  AgentConfig,
  AgentCore,
  AgentInstance,
  AgentManager,
} from "./types.js";

/**
 * DefaultAgentManager — in-memory agent registry.
 *
 * Manages agent configs and instances. Uses an AgentCore backend
 * to create actual AgentInstance objects.
 */
export class DefaultAgentManager implements AgentManager {
  private configs = new Map<string, AgentConfig>();
  private instances = new Map<string, AgentInstance>();

  constructor(private core: AgentCore) {}

  async create(config: AgentConfig): Promise<AgentInstance> {
    if (this.configs.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }

    const instance = this.core.createAgent(config);
    this.configs.set(config.id, config);
    this.instances.set(config.id, instance);
    return instance;
  }

  get(id: string): AgentInstance | undefined {
    return this.instances.get(id);
  }

  list(): AgentConfig[] {
    return Array.from(this.configs.values());
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance> {
    const existing = this.configs.get(id);
    if (!existing) {
      throw new Error(`Agent "${id}" not found`);
    }

    // Merge updates into existing config
    const updated: AgentConfig = {
      ...existing,
      ...updates,
      id, // id cannot be changed
    };

    // Re-create instance with new config
    const instance = this.core.createAgent(updated);
    this.configs.set(id, updated);
    this.instances.set(id, instance);
    return instance;
  }

  async delete(id: string): Promise<void> {
    if (!this.configs.has(id)) {
      throw new Error(`Agent "${id}" not found`);
    }
    this.configs.delete(id);
    this.instances.delete(id);
  }

  async getPrompt(id: string): Promise<string> {
    const config = this.configs.get(id);
    if (!config) {
      throw new Error(`Agent "${id}" not found`);
    }
    return config.systemPrompt;
  }

  async updatePrompt(id: string, prompt: string): Promise<void> {
    await this.update(id, { systemPrompt: prompt });
  }
}
