// src/core/agent-manager.ts — Agent lifecycle management
// Creates, stores, and manages AgentInstance objects.

import type {
  AgentConfig,
  AgentCore,
  AgentInstance,
  AgentManager,
} from "./types.js";
import {
  buildSystemPrompt,
  ensureWorkspaceStructure,
  loadWorkspaceContext,
  type WorkspaceContext,
} from "./workspace.js";

/**
 * DefaultAgentManager — in-memory agent registry.
 *
 * Manages agent configs and instances. Uses an AgentCore backend
 * to create actual AgentInstance objects. Supports workspace isolation
 * where each agent can have its own workspace directory.
 */
export class DefaultAgentManager implements AgentManager {
  private configs = new Map<string, AgentConfig>();
  private instances = new Map<string, AgentInstance>();
  private workspaces = new Map<string, WorkspaceContext>();

  constructor(private core: AgentCore) {}

  async create(config: AgentConfig): Promise<AgentInstance> {
    if (this.configs.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }

    // Load workspace context if workspacePath is specified
    let workspace: WorkspaceContext | null = null;
    if (config.workspacePath) {
      await ensureWorkspaceStructure(config.workspacePath);
      workspace = await loadWorkspaceContext(config.workspacePath);
      this.workspaces.set(config.id, workspace);
    }

    // Build final system prompt with workspace additions
    const finalConfig: AgentConfig = {
      ...config,
      systemPrompt: buildSystemPrompt(config.systemPrompt, workspace),
    };

    const instance = this.core.createAgent(finalConfig);
    this.configs.set(config.id, config); // Store original config
    this.instances.set(config.id, instance);
    return instance;
  }

  get(id: string): AgentInstance | undefined {
    return this.instances.get(id);
  }

  /** Get the workspace context for an agent */
  getWorkspace(id: string): WorkspaceContext | undefined {
    return this.workspaces.get(id);
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

    // Reload workspace if path changed or exists
    let workspace: WorkspaceContext | null = null;
    if (updated.workspacePath) {
      await ensureWorkspaceStructure(updated.workspacePath);
      workspace = await loadWorkspaceContext(updated.workspacePath);
      this.workspaces.set(id, workspace);
    }

    // Build final system prompt
    const finalConfig: AgentConfig = {
      ...updated,
      systemPrompt: buildSystemPrompt(updated.systemPrompt, workspace),
    };

    // Re-create instance with new config
    const instance = this.core.createAgent(finalConfig);
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
    this.workspaces.delete(id);
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

  /** Reload workspace context for an agent (e.g., after MEMORY.md changes) */
  async reloadWorkspace(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      throw new Error(`Agent "${id}" not found`);
    }
    if (config.workspacePath) {
      await this.update(id, {}); // Re-runs workspace loading
    }
  }
}
