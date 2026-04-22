// src/core/agent-manager.ts — Agent lifecycle management

import type { AgentConfig } from "./types.js";
import { PiMonoCore, PiMonoInstance } from "./pi-mono.js";
import { resolveBundledSkillsDir } from "../skills/bundled-dir.js";
import {
  buildSystemPrompt,
  ensureWorkspaceStructure,
  loadWorkspaceContext,
  type WorkspaceContext,
} from "./workspace.js";

/** Options for creating an agent with workspace awareness. */
export interface AgentCreateOptions {
  /** Resolved workspace path for this agent */
  workspacePath?: string;
  /** Tool guard prompt section (stored for hot-reload persistence) */
  toolGuardPrompt?: string;
  /** Base system prompt before workspace assembly (for hot-reload rebuild) */
  baseSystemPrompt?: string;
}

/** Internal entry combining config, instance, and workspace */
interface AgentEntry {
  config: AgentConfig;
  instance: PiMonoInstance;
  workspace: WorkspaceContext | null;
  /** Base system prompt before workspace assembly (for hot-reload) */
  baseSystemPrompt: string;
  /** Resolved workspace path */
  workspacePath?: string;
  /** Tool guard prompt section (re-appended on hot-reload) */
  toolGuardPrompt?: string;
}

/**
 * DefaultAgentManager — in-memory {@link AgentManager} implementation.
 *
 * Manages agent configs and instances backed by an {@link PiMonoCore}.
 * Each agent can optionally have its own workspace directory containing
 * SOUL.md, MEMORY.md, and other context files that are merged into
 * the system prompt.
 */
export class DefaultAgentManager {
  private agents = new Map<string, AgentEntry>();

  constructor(private core: PiMonoCore) {}

  /**
   * Create a new agent.
   *
   * When called from cli.ts, the system prompt is already fully assembled
   * (workspace context + tool guards included). The options provide workspace
   * metadata needed for hot-reload.
   */
  async create(config: AgentConfig, options?: AgentCreateOptions): Promise<PiMonoInstance> {
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
    });
    return instance;
  }

  get(id: string): PiMonoInstance | undefined {
    return this.agents.get(id)?.instance;
  }

  /** Get the workspace context for an agent */
  getWorkspace(id: string): WorkspaceContext | undefined {
    return this.agents.get(id)?.workspace ?? undefined;
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values()).map((e) => e.config);
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<PiMonoInstance> {
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
   * Re-reads workspace files from disk, rebuilds the system prompt from
   * the base prompt + fresh workspace context + stored tool guard prompt.
   */
  async reloadWorkspace(id: string): Promise<void> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }

    if (!entry.workspacePath) {
      return;
    }

    await ensureWorkspaceStructure(entry.workspacePath);

    const workspace = await loadWorkspaceContext(entry.workspacePath, { bundledPath: resolveBundledSkillsDir() });
    let systemPrompt = buildSystemPrompt(entry.baseSystemPrompt, workspace);
    entry.workspace = workspace;

    if (entry.toolGuardPrompt) {
      systemPrompt = [systemPrompt, entry.toolGuardPrompt].filter(Boolean).join("\n\n---\n\n");
    }

    await this.update(id, { systemPrompt });
  }
}
