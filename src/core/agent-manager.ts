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
import { WorkspaceContextLoader } from "../workspace/context-loader.js";

/** Options for creating an agent with workspace awareness. */
export interface AgentCreateOptions {
  /** Resolved workspace path for this agent */
  workspacePath?: string;
  /** Tool guard prompt section (stored for hot-reload persistence) */
  toolGuardPrompt?: string;
  /** Base system prompt before workspace assembly (for hot-reload rebuild) */
  baseSystemPrompt?: string;
  /** Class-based context loader for hot-reload (if provided, used instead of functional API) */
  contextLoader?: WorkspaceContextLoader;
}

/** Internal entry combining config, instance, and workspace */
interface AgentEntry {
  config: AgentConfig;
  instance: AgentInstance;
  workspace: WorkspaceContext | null;
  /** Base system prompt before workspace assembly (for hot-reload) */
  baseSystemPrompt: string;
  /** Resolved workspace path */
  workspacePath?: string;
  /** Tool guard prompt section (re-appended on hot-reload) */
  toolGuardPrompt?: string;
  /** Class-based context loader (for hot-reload via refresh) */
  contextLoader?: WorkspaceContextLoader;
}

/**
 * DefaultAgentManager — in-memory {@link AgentManager} implementation.
 *
 * Manages agent configs and instances backed by an {@link AgentCore}.
 * Each agent can optionally have its own workspace directory containing
 * SOUL.md, MEMORY.md, and other context files that are merged into
 * the system prompt.
 */
export class DefaultAgentManager implements AgentManager {
  private agents = new Map<string, AgentEntry>();

  constructor(private core: AgentCore) {}

  /**
   * Create a new agent.
   *
   * When called from cli.ts, the system prompt is already fully assembled
   * (workspace context + tool guards included). The options provide workspace
   * metadata needed for hot-reload.
   */
  async create(config: AgentConfig, options?: AgentCreateOptions): Promise<AgentInstance> {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }

    const instance = this.core.createAgent(config);
    this.agents.set(config.id, {
      config,
      instance,
      workspace: null,
      baseSystemPrompt: options?.baseSystemPrompt ?? config.systemPrompt,
      workspacePath: options?.workspacePath,
      toolGuardPrompt: options?.toolGuardPrompt,
      contextLoader: options?.contextLoader,
    });
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

    // Re-create instance with new config
    const instance = this.core.createAgent(updated);
    this.agents.set(id, {
      ...entry,
      config: updated,
      instance,
    });
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

  /**
   * Reload workspace context for an agent (hot-reload support).
   *
   * If a {@link WorkspaceContextLoader} was provided at creation, uses its
   * refresh() method. Otherwise falls back to the functional API.
   *
   * Re-reads workspace files from disk, rebuilds the system prompt from
   * the base prompt + fresh workspace context + stored tool guard prompt.
   */
  async reloadWorkspace(id: string): Promise<void> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }

    if (!entry.workspacePath) {
      return; // No workspace to reload
    }

    await ensureWorkspaceStructure(entry.workspacePath);

    // Use class-based loader if available, otherwise functional API
    let systemPrompt: string;
    if (entry.contextLoader) {
      const ctx = await entry.contextLoader.refresh();
      systemPrompt = entry.contextLoader.buildSystemPrompt(entry.baseSystemPrompt);

      // Store workspace reference as a WorkspaceContext-compatible shape
      entry.workspace = {
        systemPromptAdditions: ctx.systemPromptAdditions,
        memory: ctx.memory,
        workspacePath: ctx.workspacePath,
        skillsPrompt: ctx.skillsPrompt,
      };
    } else {
      const workspace = await loadWorkspaceContext(entry.workspacePath);
      systemPrompt = buildSystemPrompt(entry.baseSystemPrompt, workspace);
      entry.workspace = workspace;
    }

    if (entry.toolGuardPrompt) {
      systemPrompt = [systemPrompt, entry.toolGuardPrompt].filter(Boolean).join("\n\n---\n\n");
    }

    await this.update(id, { systemPrompt });
  }
}
