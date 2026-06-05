import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool, createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { createWebFetchTool } from "./web.js";
import { createReactTools } from "./react.js";
import type { LazyChannelContext } from "../../channels/types.js";
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
}

export function createAgentTools(opts: CreateAgentToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [
    ...createFsTools(opts.workspacePath),
    createTimeTool(),
    createBashTool(opts.workspacePath, { operations: createLocalBashOperations() }) as AgentTool,
    createWebFetchTool(),
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
  }
  return tools;
}
