import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import { createWebFetchTool } from "./web.js";
import { createReactTools } from "./react.js";
import type { LazyChannelContext } from "../../channels/types.js";
import type { AgentRuntime } from "../runtime.js";
import { createTimeTool } from "./time.js";
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
  const ws = opts.workspacePath;
  const tools: AgentTool[] = [
    createReadTool(ws) as AgentTool,
    createWriteTool(ws) as AgentTool,
    createEditTool(ws) as AgentTool,
    createLsTool(ws) as AgentTool,
    createTimeTool(),
    createBashTool(ws) as AgentTool,
    createWebFetchTool(),
    createSpawnAgentTool({
      runtime: opts.runtime,
      parentAgentId: opts.parentAgentId,
      parentSessionId: opts.parentSessionId,
      workspacePath: ws,
      ...(opts.spawnableAgentIds ? { spawnableAgentIds: opts.spawnableAgentIds } : {}),
    }),
  ];
  if (opts.channelContext) {
    tools.push(...createReactTools(opts.channelContext));
  }
  return tools;
}
