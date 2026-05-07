import type { AgentTool } from "@mariozechner/pi-agent-core";
import { HostFs, SandboxFs, type FsBridge } from "../middleware/fs.js";
import { HostExecutor, type Executor, type SandboxExecutor } from "../middleware/executor.js";
import { type SandboxConfig } from "../middleware/sandbox-config.js";
import { createWebFetchTool } from "./web.js";
import { createReactTools } from "./react.js";
import type { LazyTransportContext } from "../../legacy/gateway/transport-context.js";
import { createExecTools } from "./exec.js";
import { createTimeTool } from "./time.js";
import { createFsTools } from "./fs-tools.js";

export interface CreateAgentToolsOptions {
  workspacePath: string;
  agentId: string;
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

  const tools: AgentTool[] = [
    ...createFsTools(opts.workspacePath, fs),
    createTimeTool(),
    ...createExecTools({ cwd: opts.workspacePath, executor }),
    createWebFetchTool(executor),
  ];
  if (opts.transportContext) {
    tools.push(...createReactTools(opts.transportContext));
  }
  return tools;
}
