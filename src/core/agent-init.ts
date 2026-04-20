// src/core/agent-init.ts — Shared agent initialization logic
// Used by both CLI (src/cli.ts) and TUI (src/tui/ChatScreen.tsx).

import { resolveBundledSkillsDir } from "../skills/bundled-dir.js";
import {
  toAgentConfig,
  type AgentConfigFile,
  type AgentDefaultsConfigFile,
  type CompactionConfigFile,
  type SandboxConfigFile,
  type AgentToolsConfigFile,
  type ProviderConfigFile,
  type SubagentConfigFile,
} from "./config.js";
import {
  ensureExplicitWorkspaceDir,
  ensureWorkspaceDir,
  resolveExplicitWorkspacePath,
} from "./paths.js";
import {
  loadWorkspaceContext,
  buildSystemPrompt,
  ensureWorkspaceStructure,
} from "./workspace.js";
import { seedWorkspaceTemplates } from "../workspace/templates.js";
import { reconcileWorkspaceState } from "../workspace/state.js";
import {
  ToolRegistry,
  buildToolGuardPrompt,
  createWorkspaceToolsWithGuards,
  resolveToolGuards,
  applyToolPolicy,
} from "./tools.js";
import { createReplyReactTools, LazyTransportContext } from "../tools/reply-react.js";
import { createExecTools, ProcessRegistry } from "../tools/exec.js";
import { SandboxExecutor, SandboxFs, shouldSandbox, type FsLike } from "../sandbox/index.js";
import * as nodeFs from "node:fs/promises";
import type { PiMonoCore } from "./pi-mono.js";
import type { DefaultAgentManager } from "./agent-manager.js";
import type { AgentConfig, AgentInstance } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("agent-init");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitAgentOptions {
  /** Raw agent config from YAML */
  agentFile: AgentConfigFile;
  /** Shared agent defaults from config */
  agentDefaults?: AgentDefaultsConfigFile;
  /** Provider config */
  provider?: ProviderConfigFile;
  /** Global tool settings */
  globalTools?: AgentToolsConfigFile;
  /** Compaction config */
  compaction?: CompactionConfigFile;
  /** Sandbox config */
  sandbox?: SandboxConfigFile;
  /** Subagent config */
  subagent?: SubagentConfigFile;
  /** AgentCore implementation */
  core: PiMonoCore;
  /** Agent manager */
  agentManager: DefaultAgentManager;
  /** Whether this is the only agent (affects workspace naming) */
  isSingleAgent?: boolean;
  /** Pre-built sandbox executor (optional — no sandbox if omitted) */
  sandboxExecutor?: SandboxExecutor;
  /** Transport context for reply/react tools (optional — skipped if omitted) */
  transportContext?: LazyTransportContext;
}

export interface InitAgentResult {
  agentConfig: AgentConfig;
  instance: AgentInstance;
  workspacePath: string;
  toolRegistry: ToolRegistry;
  processRegistry: ProcessRegistry;
  transportContext?: LazyTransportContext;
  baseSystemPrompt: string;
  toolGuardPrompt: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function initializeAgent(opts: InitAgentOptions): Promise<InitAgentResult> {
  const {
    agentFile,
    agentDefaults,
    provider,
    globalTools,
    compaction,
    sandbox,
    subagent,
    core,
    agentManager,
    isSingleAgent = true,
    sandboxExecutor,
    transportContext,
  } = opts;

  // 1. Resolve agent config
  const agentConfig = toAgentConfig(agentFile, agentDefaults, provider, globalTools, compaction, sandbox);

  // 2. Resolve workspace path
  let workspacePath: string;
  if (agentFile.workspace) {
    const resolved = resolveExplicitWorkspacePath(agentFile.workspace);
    workspacePath = await ensureExplicitWorkspaceDir(resolved);
    log.info(`Using explicit workspace for ${agentConfig.id}: ${workspacePath}`);
  } else {
    const workspaceKey = isSingleAgent ? "default" : agentConfig.id;
    workspacePath = await ensureWorkspaceDir(workspaceKey);
  }

  // 3. Seed workspace templates on first creation
  const seededFiles = await seedWorkspaceTemplates(workspacePath);
  if (seededFiles.length > 0) {
    log.info(`Seeded ${seededFiles.length} template file(s) for ${agentConfig.id}: ${seededFiles.join(", ")}`);
  }

  // 4. Reconcile workspace state
  await reconcileWorkspaceState(workspacePath);

  // 5. Ensure workspace directory structure exists (sessions/, memory/)
  await ensureWorkspaceStructure(workspacePath);

  // 6. Load workspace context (SOUL.md, TOOLS.md, MEMORY.md, etc.)
  const workspaceContext = await loadWorkspaceContext(workspacePath, { bundledPath: resolveBundledSkillsDir() });
  const baseSystemPrompt = agentConfig.systemPrompt;
  agentConfig.systemPrompt = buildSystemPrompt(agentConfig.systemPrompt, workspaceContext);
  log.debug(`Loaded workspace context for ${agentConfig.id}: systemPrompt=${workspaceContext.systemPromptAdditions.length > 0}, memory=${workspaceContext.memory !== null}`);

  // 7. Create tool registry and process registry
  const resolvedToolGuards = resolveToolGuards(agentConfig.toolSettings);
  const toolRegistry = new ToolRegistry();
  const processRegistry = new ProcessRegistry();
  const subagentEnabled = subagent?.enabled === true;
  const agentAllowedWorkspaces = agentFile.allowedWorkspaces ?? [];

  // 8. Resolve fs implementation (host vs sandbox)
  const fsImpl: FsLike = sandboxExecutor && agentConfig.sandbox && shouldSandbox(agentConfig.sandbox, false)
    ? new SandboxFs(sandboxExecutor, agentConfig.id)
    : nodeFs;

  // 9. Create and register workspace tools
  const workspaceTools = createWorkspaceToolsWithGuards(
    workspacePath,
    agentConfig.toolSettings,
    subagentEnabled,
    agentAllowedWorkspaces,
    agentConfig.codingMode,
    subagent?.maxTurns,
    fsImpl,
    agentConfig.id,
    agentConfig.provider,
    toolRegistry,
  );
  const filteredTools = applyToolPolicy(workspaceTools, agentConfig.toolSettings);
  for (const { tool, handler } of filteredTools) {
    toolRegistry.register(tool, handler);
  }

  // 10. Register reply/react tools (transport is bound lazily after transport starts)
  if (transportContext) {
    for (const { tool, handler } of createReplyReactTools(transportContext)) {
      toolRegistry.register(tool, handler);
    }
  }

  // 11. Register exec/process tools
  if (resolvedToolGuards.cli) {
    const execTools = createExecTools({
      cwd: workspacePath,
      registry: processRegistry,
      sandboxExecutor,
      agentId: agentConfig.id,
      isMainAgent: false,
      agentSandboxConfig: agentConfig.sandbox,
      allowedWorkspaces: agentAllowedWorkspaces,
    });
    const filteredExecTools = applyToolPolicy(execTools, agentConfig.toolSettings);
    for (const { tool, handler } of filteredExecTools) {
      toolRegistry.register(tool, handler);
    }
  }

  // 12. Build tool guard prompt and append to system prompt
  const toolGuardPrompt = buildToolGuardPrompt(toolRegistry.list(), resolvedToolGuards, workspacePath, agentAllowedWorkspaces);
  agentConfig.systemPrompt = [
    agentConfig.systemPrompt,
    toolGuardPrompt,
  ].filter(Boolean).join("\n\n---\n\n");

  // 13. Wire up tool registry and create agent
  core.setToolRegistry(agentConfig.id, toolRegistry);
  const instance = await agentManager.create(agentConfig, { workspacePath, toolGuardPrompt, baseSystemPrompt });
  log.info(`Created agent: ${agentConfig.id} (workspace: ${workspacePath}, tools: ${toolRegistry.list().length})`);

  return {
    agentConfig,
    instance,
    workspacePath,
    toolRegistry,
    processRegistry,
    transportContext,
    baseSystemPrompt,
    toolGuardPrompt,
  };
}
