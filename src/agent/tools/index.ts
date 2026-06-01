import type { AgentTool } from "@mariozechner/pi-agent-core";
import { HostFs, SandboxFs, type FsBridge } from "../middleware/fs.js";
import { HostExecutor, type Executor, type SandboxExecutor } from "../middleware/executor.js";
import { type SandboxConfig } from "../middleware/sandbox-config.js";
import { createWebFetchTool } from "./web.js";
import { createReactTools } from "./react.js";
import { createMessageTools } from "./message.js";
import type { LazyChannelContext } from "../../channels/types.js";
import { createExecTools } from "./exec.js";
import type { AgentRuntime } from "../runtime.js";
import { createTimeTool } from "./time.js";
import { createFsTools } from "./fs-tools.js";
import { createSpawnAgentTool } from "./spawn-agent.js";

export interface CreateAgentToolsOptions {
  workspacePath: string;
  agentId: string;
  parentAgentId: string;
  /** Caller session id; bound into spawn-agent's closure. */
  parentSessionId: string;
  runtime: AgentRuntime;
  spawnableAgentIds?: readonly string[];
  channelContext?: LazyChannelContext;
  allowedChannels?: string[];
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

  const tools: AgentTool[] = [
    ...createFsTools(opts.workspacePath, fs),
    createTimeTool(),
    ...createExecTools({ cwd: opts.workspacePath, executor }),
    createWebFetchTool(executor),
    createSpawnAgentTool({
      runtime: opts.runtime,
      parentAgentId: opts.parentAgentId,
      parentSessionId: opts.parentSessionId,
      workspacePath: opts.workspacePath,
      ...(opts.spawnableAgentIds ? { spawnableAgentIds: opts.spawnableAgentIds } : {}),
    }),
  ];
  if (opts.channelContext) {
    tools.push(...createReactTools(opts.channelContext));
    tools.push(...createMessageTools(opts.channelContext, opts.allowedChannels));
  }
  return tools;
}
