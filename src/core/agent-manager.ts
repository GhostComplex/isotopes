// src/core/agent-manager.ts — Agent lifecycle management

import type { AgentConfig } from "./types.js";
import { PiMonoCore, AgentServiceCache } from "./pi-mono.js";
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

/** Internal entry combining config, cache, and workspace */
interface AgentEntry {
  config: AgentConfig;
  cache: AgentServiceCache;
  workspace: WorkspaceContext | null;
  /** Base system prompt before workspace assembly (for hot-reload) */
  baseSystemPrompt: string;
  /** Resolved workspace path */
  workspacePath?: string;
  /** Tool guard prompt section (re-appended on hot-reload) */
  toolGuardPrompt?: string;
}

/**
 * DefaultAgentManager — in-memory agent registry.
 *
 * Manages agent configs and {@link AgentServiceCache} instances backed by
 * a {@link PiMonoCore}. Each agent can optionally have its own workspace
 * directory containing SOUL.md, MEMORY.md, and other context files that
 * are merged into the system prompt.
 */
export class DefaultAgentManager {
  private agents = new Map<string, AgentEntry>();

  constructor(private core: PiMonoCore) {}

  async create(config: AgentConfig, options?: AgentCreateOptions): Promise<AgentServiceCache> {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }

    const cache = this.core.createServiceCache(config);
    this.agents.set(config.id, {
      config,
      cache,
      workspace: null,
      baseSystemPrompt: options?.baseSystemPrompt ?? config.systemPrompt,
      workspacePath: options?.workspacePath,
      toolGuardPrompt: options?.toolGuardPrompt,
    });
    return cache;
  }

  get(id: string): AgentServiceCache | undefined {
    return this.agents.get(id)?.cache;
  }

  getConfig(id: string): AgentConfig | undefined {
    return this.agents.get(id)?.config;
  }

  getWorkspace(id: string): WorkspaceContext | undefined {
    return this.agents.get(id)?.workspace ?? undefined;
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values()).map((e) => e.config);
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<AgentServiceCache> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }

    const updated: AgentConfig = {
      ...entry.config,
      ...updates,
      id,
    };

    const cache = this.core.createServiceCache(updated);
    this.agents.set(id, {
      ...entry,
      config: updated,
      cache,
    });
    return cache;
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
