// src/core/agent-init.ts — Shared agent initialization logic
// Used by both CLI (src/legacy/cli.ts) and TUI (src/tui/ChatScreen.tsx).

import {
  toAgentConfig,
  type AgentConfigFile,
  type AgentDefaultsConfigFile,
  type CompactionConfigFile,
  type SandboxConfigFile,
  type AgentToolsConfigFile,
  type ProviderConfigFile,
  type SpawningConfigFile,
} from "../config.js";
import {
  ensureExplicitWorkspaceDir,
  ensureWorkspaceDir,
  resolveExplicitWorkspacePath,
} from "../paths.js";
import { ensureWorkspaceStructure } from "./workspace.js";
import { seedWorkspaceTemplates } from "../legacy/workspace/templates.js";
import { reconcileWorkspaceState } from "../legacy/workspace/state.js";
import { createAgentTools } from "../legacy/core/tools.js";
import { LazyTransportContext } from "../legacy/tools/react.js";
import { ProcessRegistry } from "../legacy/tools/exec.js";
import { SandboxExecutor, SandboxFs, shouldSandbox } from "../legacy/sandbox/index.js";
import * as nodeFs from "node:fs/promises";
import type { AgentConfig } from "./types.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createLogger } from "../logging/logger.js";
import type { HookRegistry } from "../legacy/plugins/hooks.js";

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
  /** Spawning config */
  spawning?: SpawningConfigFile;
  /** Pre-built sandbox executor (optional — no sandbox if omitted) */
  sandboxExecutor?: SandboxExecutor;
  /** Transport context for react tools (optional — skipped if omitted) */
  transportContext?: LazyTransportContext;
  /** Hook registry for lifecycle events (optional) */
  hooks?: HookRegistry;
  /** Pre-computed list of spawnable agent IDs from config */
  spawnableAgentIds?: string[];
  /** Unified runtime — wired into the send_message tool. */
  runtime?: import("../legacy/agents/runtime.js").AgentRuntime;
}

export interface InitAgentResult {
  agentConfig: AgentConfig;
  workspacePath: string;
  tools: AgentTool[];
  processRegistry: ProcessRegistry;
  transportContext?: LazyTransportContext;
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
    spawning,
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
    workspacePath = await ensureWorkspaceDir(agentConfig.id);
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

  const isSandboxed = !!(sandboxExecutor && agentConfig.sandbox && shouldSandbox(agentConfig.sandbox, false));
  const fsImpl = isSandboxed ? new SandboxFs(sandboxExecutor!, agentConfig.id) : nodeFs;

  // Spawn tools run host-side child processes that bypass docker — disable for
  // sandboxed agents (#440).
  const spawningEnabled = spawning?.enabled === true && !isSandboxed;
  if (spawning?.enabled === true && isSandboxed) {
    log.warn(
      `Spawning tools disabled for ${agentConfig.id}: sandbox is active and child runners cannot be confined.`,
    );
  }

  const processRegistry = new ProcessRegistry();
  const tools: AgentTool[] = createAgentTools({
    workspacePath,
    settings: agentConfig.toolSettings,
    sendMessageEnabled: spawningEnabled,
    codingMode: agentConfig.codingMode,
    fsImpl,
    parentAgentId: agentConfig.id,
    agentId: agentConfig.id,
    processRegistry,
    sandboxExecutor,
    agentSandboxConfig: agentConfig.sandbox,
    allowedWorkspaces: agentFile.allowedWorkspaces ?? [],
    transportContext,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    ...(opts.spawnableAgentIds ? { spawnableAgentIds: opts.spawnableAgentIds } : {}),
  });

  if (opts.hooks) {
    await opts.hooks.emit("before_agent_start", { agentId: agentConfig.id });
  }
  log.info(`Initialized agent: ${agentConfig.id} (workspace: ${workspacePath}, tools: ${tools.length})`);

  return {
    agentConfig,
    workspacePath,
    tools,
    processRegistry,
    transportContext,
  };
}
