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

/** Internal entry combining config, instance, and workspace */
interface AgentEntry {
  config: AgentConfig;
  instance: AgentInstance;
  workspace: WorkspaceContext | null;
}

/**
 * DefaultAgentManager — in-memory agent registry.
 *
 * Manages agent configs and instances. Uses an AgentCore backend
 * to create actual AgentInstance objects. Supports workspace isolation
 * where each agent can have its own workspace directory.
 */
export class DefaultAgentManager implements AgentManager {
  private agents = new Map<string, AgentEntry>();

  constructor(private core: AgentCore) {}

  async create(config: AgentConfig): Promise<AgentInstance> {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }

    // Load workspace context if workspacePath is specified
    let workspace: WorkspaceContext | null = null;
    if (config.workspacePath) {
      await ensureWorkspaceStructure(config.workspacePath);
      workspace = await loadWorkspaceContext(config.workspacePath);
    }

    // Build final system prompt with workspace additions
    const finalConfig: AgentConfig = {
      ...config,
      systemPrompt: buildSystemPrompt(config.systemPrompt, workspace),
    };

    const instance = this.core.createAgent(finalConfig);
    this.agents.set(config.id, { config, instance, workspace });
    return instance;
  }

  get(id: string): AgentInstance | undefined {
    return this.agents.get(id)?.instance;
  }

  /** Get the workspace context for an agent */
  getWorkspace(id: string): WorkspaceContext | undefined {
    return this.agents.get(id)?.workspace ?? undefined;
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values()).map((e) => e.config);
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }

    // Merge updates into existing config
    const updated: AgentConfig = {
      ...entry.config,
      ...updates,
      id, // id cannot be changed
    };

    // Reload workspace if path changed or exists
    let workspace: WorkspaceContext | null = null;
    if (updated.workspacePath) {
      await ensureWorkspaceStructure(updated.workspacePath);
      workspace = await loadWorkspaceContext(updated.workspacePath);
    }

    // Build final system prompt
    const finalConfig: AgentConfig = {
      ...updated,
      systemPrompt: buildSystemPrompt(updated.systemPrompt, workspace),
    };

    // Re-create instance with new config
    const instance = this.core.createAgent(finalConfig);
    this.agents.set(id, { config: updated, instance, workspace });
    return instance;
  }

  async delete(id: string): Promise<void> {
    if (!this.agents.has(id)) {
      throw new Error(`Agent "${id}" not found`);
    }
    this.agents.delete(id);
  }

  async getPrompt(id: string): Promise<string> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }
    return entry.config.systemPrompt;
  }

  async updatePrompt(id: string, prompt: string): Promise<void> {
    await this.update(id, { systemPrompt: prompt });
  }

  /** Reload workspace context for an agent (e.g., after MEMORY.md changes) */
  async reloadWorkspace(id: string): Promise<void> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }
    if (entry.config.workspacePath) {
      await this.update(id, {}); // Re-runs workspace loading
    }
  }
}
