// src/core/agent-manager.ts — Agent lifecycle management

import type { AgentConfig } from "../../agent/types.js";
import { resolveBundledSkillsDir } from "../skills/bundled-dir.js";
import {
  buildSystemPrompt,
  ensureWorkspaceStructure,
  loadWorkspaceContext,
  type WorkspaceContext,
} from "../../agent/workspace.js";

/** Options for creating an agent with workspace awareness. */
export interface AgentCreateOptions {
  /** Resolved workspace path for this agent */
  workspacePath?: string;
  /** Tool guard prompt section (stored for hot-reload persistence) */
  toolGuardPrompt?: string;
  /** Fully assembled system prompt (workspace + tool guards already merged) */
  initialSystemPrompt?: string;
}

/** Internal entry combining config and workspace */
interface AgentEntry {
  config: AgentConfig;
  workspace: WorkspaceContext | null;
  /** Assembled system prompt (workspace context + tool guards) */
  systemPrompt: string;
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
 * Manages agent configs and workspace context. Per-agent SDK deps are no
 * longer cached here — the pi runner builds them per session via
 * createPiAgentSession.
 */
export class DefaultAgentManager {
  private agents = new Map<string, AgentEntry>();

  async create(config: AgentConfig, options?: AgentCreateOptions): Promise<void> {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }
    this.agents.set(config.id, {
      config,
      workspace: null,
      systemPrompt: options?.initialSystemPrompt ?? "",
      baseSystemPrompt: "",
      workspacePath: options?.workspacePath,
      toolGuardPrompt: options?.toolGuardPrompt,
    });
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id)?.config;
  }

  getConfig(id: string): AgentConfig | undefined {
    return this.agents.get(id)?.config;
  }

  getSystemPrompt(id: string): string | undefined {
    return this.agents.get(id)?.systemPrompt;
  }

  getWorkspace(id: string): WorkspaceContext | undefined {
    return this.agents.get(id)?.workspace ?? undefined;
  }

  getWorkspacePath(id: string): string | undefined {
    return this.agents.get(id)?.workspacePath;
  }

  list(): AgentConfig[] {
    return Array.from(this.agents.values()).map((e) => e.config);
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<void> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }

    const updated: AgentConfig = {
      ...entry.config,
      ...updates,
      id,
    };

    this.agents.set(id, {
      ...entry,
      config: updated,
    });
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
    return entry.systemPrompt;
  }

  async updatePrompt(id: string, prompt: string): Promise<void> {
    const entry = this.agents.get(id);
    if (!entry) {
      throw new Error(`Agent "${id}" not found`);
    }
    entry.systemPrompt = prompt;
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

    entry.systemPrompt = systemPrompt;
  }
}
