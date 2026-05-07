import type { AgentTool } from "@mariozechner/pi-agent-core";
import { HostFs, SandboxFs, type FsBridge } from "../middleware/fs.js";
import { HostExecutor, type Executor, type SandboxExecutor } from "../middleware/executor.js";
import { type SandboxConfig } from "../middleware/sandbox-config.js";
import { createWebFetchTool } from "./web.js";
import { createReactTools } from "./react.js";
import type { LazyTransportContext } from "../../legacy/gateway/transport-context.js";
import { createExecTools } from "./exec.js";
import type { AgentRuntime } from "../runtime.js";
import { createLogger } from "../../logging/logger.js";
import { createTimeTool } from "./time.js";
import { createFsTools } from "./fs-tools.js";
import { createSpawnAgentTool } from "./spawn-agent.js";

const log = createLogger("tools");

export interface CreateAgentToolsOptions {
  workspacePath: string;
  agentId: string;
  parentAgentId?: string;
  /** Required for the spawn_agent tool. */
  runtime?: AgentRuntime;
  /** Pre-computed list of registered agent ids the LLM can address. */
  spawnableAgentIds?: string[];
  transportContext?: LazyTransportContext;
  agentSandboxConfig?: SandboxConfig;
  /** Required when agentSandboxConfig.enabled — provided by AgentRuntime. */
  sandboxExecutor?: SandboxExecutor;
}

export function createAgentTools(opts: CreateAgentToolsOptions): AgentTool[] {
  const isSandboxed = !!opts.agentSandboxConfig?.enabled;
  if (isSandboxed && !opts.sandboxExecutor) {
    throw new Error(
      `agent "${opts.agentId}" requires sandbox but no sandbox infrastructure is configured. ` +
      "Define `sandbox.docker` in isotopes.yaml (top-level or agents.defaults.sandbox).",
    );
  }
  if (isSandboxed && opts.agentSandboxConfig) {
    opts.sandboxExecutor!.registerAgent(opts.agentId, opts.agentSandboxConfig);
  }
  const executor: Executor = isSandboxed
    ? opts.sandboxExecutor!.bind(opts.agentId)
    : new HostExecutor();
  const fs: FsBridge = isSandboxed
    ? new SandboxFs(opts.sandboxExecutor!, opts.agentId)
    : new HostFs();
  const spawnAgentEnabled = !isSandboxed;
  if (isSandboxed) {
    log.warn(`spawn_agent tool disabled for ${opts.agentId}: sandbox is active and child runners cannot be confined.`);
  }

  const tools: AgentTool[] = [
    ...createFsTools(opts.workspacePath, fs),
    createTimeTool(),
    ...createExecTools({
      cwd: opts.workspacePath,
      executor,
    }),
  ];
  if (spawnAgentEnabled && opts.runtime && opts.parentAgentId) {
    tools.push(createSpawnAgentTool({
      runtime: opts.runtime,
      parentAgentId: opts.parentAgentId,
      workspacePath: opts.workspacePath,
      ...(opts.spawnableAgentIds ? { spawnableAgentIds: opts.spawnableAgentIds } : {}),
    }));
  }
  tools.push(createWebFetchTool(executor));
  if (opts.transportContext) {
    tools.push(...createReactTools(opts.transportContext));
  }

  return tools;
}
