// src/orchestrator/agent-manager.ts — Persisted agent manager (JSON + SOUL.md)

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentCore, AgentConfig, AgentInstance, ProviderConfig } from '../core/types.js';

/** Metadata persisted to agents.json (no system prompt — that lives in SOUL.md) */
export interface AgentMetadata {
  id: string;
  name: string;
  provider?: ProviderConfig;
  tools?: string[];
}

/** Manages agent lifecycle — persisted to JSON + workspace files */
export interface AgentManager {
  create(config: AgentConfig): Promise<AgentInstance>;
  get(id: string): AgentInstance | undefined;
  list(): AgentMetadata[];
  update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  getPrompt(id: string): Promise<string>;
  updatePrompt(id: string, prompt: string): Promise<void>;
}

export class JsonAgentManager implements AgentManager {
  private agents = new Map<string, { config: AgentConfig; instance: AgentInstance }>();

  constructor(
    private core: AgentCore,
    private dataDir: string,
  ) {}

  /** Load existing agents from disk on startup */
  async init(): Promise<void> {
    const metaPath = this.metaPath();
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const metas: AgentMetadata[] = JSON.parse(raw);
      for (const meta of metas) {
        try {
          const systemPrompt = await this.getPrompt(meta.id);
          // tools in metadata are string names; actual Tool objects are not persisted
          const config: AgentConfig = {
            id: meta.id,
            name: meta.name,
            systemPrompt,
            provider: meta.provider,
          };
          const instance = this.core.createAgent(config);
          this.agents.set(meta.id, { config, instance });
        } catch {
          // Agent data dir may be missing, skip gracefully
        }
      }
    } catch {
      // No agents.json yet — first run
    }
  }

  async create(config: AgentConfig): Promise<AgentInstance> {
    // Ensure agent data directory exists
    const agentDir = path.join(this.dataDir, 'agents', config.id);
    await fs.mkdir(agentDir, { recursive: true });

    // Write SOUL.md
    await fs.writeFile(path.join(agentDir, 'SOUL.md'), config.systemPrompt);

    // Create instance
    const instance = this.core.createAgent(config);
    this.agents.set(config.id, { config, instance });

    // Persist metadata
    await this.persistMeta();

    return instance;
  }

  get(id: string): AgentInstance | undefined {
    return this.agents.get(id)?.instance;
  }

  list(): AgentMetadata[] {
    return [...this.agents.values()].map(({ config }) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      tools: config.tools?.map((t) => t.name),
    }));
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance> {
    const existing = this.agents.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);

    const newConfig = { ...existing.config, ...updates, id };

    if (updates.systemPrompt) {
      await this.updatePrompt(id, updates.systemPrompt);
    }

    const instance = this.core.createAgent(newConfig);
    this.agents.set(id, { config: newConfig, instance });

    await this.persistMeta();

    return instance;
  }

  async delete(id: string): Promise<void> {
    this.agents.delete(id);

    // Remove agent data directory
    const agentDir = path.join(this.dataDir, 'agents', id);
    await fs.rm(agentDir, { recursive: true, force: true });

    await this.persistMeta();
  }

  async getPrompt(id: string): Promise<string> {
    const soulPath = path.join(this.dataDir, 'agents', id, 'SOUL.md');
    return fs.readFile(soulPath, 'utf-8');
  }

  async updatePrompt(id: string, prompt: string): Promise<void> {
    const agentDir = path.join(this.dataDir, 'agents', id);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'SOUL.md'), prompt);
    await this.reload(id);
  }

  // --- Private helpers ---

  private async reload(id: string): Promise<void> {
    const existing = this.agents.get(id);
    if (!existing) return;

    const systemPrompt = await this.getPrompt(id);
    const config = { ...existing.config, systemPrompt };
    const instance = this.core.createAgent(config);
    this.agents.set(id, { config, instance });
  }

  private async persistMeta(): Promise<void> {
    const metas = this.list();
    const metaPath = this.metaPath();
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(metas, null, 2));
  }

  private metaPath(): string {
    return path.join(this.dataDir, 'agents.json');
  }
}
