// src/agent/runners/pi/tool-wrap.ts — Per-call wrap an isotopes tool entry
// into the SDK's ToolDefinition shape, optionally firing hooks around the call.
//
// PR A bridge: still adapts the legacy {tool, handler} shape (tool-result
// returned as string). PR B will migrate to SDK AgentTool directly and
// simplify this file dramatically (or delete it).

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Tool } from "../../../tools/types.js";
import type { ToolHandler } from "../../../legacy/core/tools.js";
import type { HookRegistry } from "../../../legacy/plugins/hooks.js";
import { truncateToolResultText } from "./tool-result-truncation.js";

export interface ToolHookCtx {
  hooks?: HookRegistry;
  agentId?: string;
}

export function wrapAgentTool(
  entry: { tool: Tool; handler: ToolHandler },
  ctx: ToolHookCtx,
): ToolDefinition {
  return {
    name: entry.tool.name,
    description: entry.tool.description,
    parameters: entry.tool.parameters as ToolDefinition["parameters"],
    label: entry.tool.name,
    execute: async (_toolCallId, params) => {
      const { hooks, agentId } = ctx;
      if (hooks && agentId) {
        await hooks.emit("before_tool_call", { agentId, toolName: entry.tool.name, args: params });
      }
      const result = await entry.handler(params);
      if (hooks && agentId) {
        await hooks.emit("after_tool_call", { agentId, toolName: entry.tool.name, args: params, result });
      }
      return {
        content: [{ type: "text", text: truncateToolResultText(result) }],
        details: {},
      };
    },
  };
}
