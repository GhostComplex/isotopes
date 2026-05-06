import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type AgentSession,
  type AuthStorage,
  type ModelRegistry,
  type ToolDefinition,
  createAgentSession,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

import type { ProviderConfig, RegisteredAgent } from "../../types.js";
import type { HookRegistry } from "../../../legacy/plugins/hooks.js";
import { overrideSessionSystemPrompt } from "./system-prompt-override.js";
import { buildAgentSystemPrompt } from "../../workspace/context.js";
import { resolveAgentWorkspacePath } from "../../../paths.js";

const ISOTOPES_HOME = process.env.ISOTOPES_HOME || path.join(process.env.HOME || "/tmp", ".isotopes");
const DEFAULT_MODEL = "claude-opus-4-7";

export interface PiSessionDeps {
  globalProvider: ProviderConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  getAgentTools: (agentId: string) => AgentTool[];
  hooks?: HookRegistry;
}

function resolveModel(globalProvider: ProviderConfig, modelId?: string): Model<Api> {
  const provider = globalProvider.type as Parameters<typeof getModel>[0];
  const id = modelId ?? globalProvider.defaultModel ?? DEFAULT_MODEL;
  const model = getModel(provider, id as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
  if (!model) throw new Error(`Unknown ${provider} model: ${id}`);

  const proxyHeaders: Record<string, string> = { ...(globalProvider.headers ?? {}) };
  if (globalProvider.baseUrl && globalProvider.apiKey) {
    proxyHeaders.Authorization ??= `Bearer ${globalProvider.apiKey}`;
  }
  if (!globalProvider.baseUrl && Object.keys(proxyHeaders).length === 0) return model;

  return {
    ...model,
    id,
    ...(globalProvider.baseUrl ? { baseUrl: globalProvider.baseUrl } : {}),
    ...(Object.keys(proxyHeaders).length > 0 ? { headers: { ...(model.headers ?? {}), ...proxyHeaders } } : {}),
  };
}

/** AgentTool → SDK ToolDefinition shim. AgentTool's execute has no ctx; the
 * shim adds it (unused) and wraps execution in before/after hooks. */
function toToolDefinition(t: AgentTool, hooks: HookRegistry | undefined, agentId: string): ToolDefinition {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    ...(t.prepareArguments ? { prepareArguments: t.prepareArguments } : {}),
    ...(t.executionMode ? { executionMode: t.executionMode } : {}),
    execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
      if (hooks) await hooks.emit("before_tool_call", { agentId, toolName: t.name, args: params });
      const result = await t.execute(toolCallId, params, signal, onUpdate);
      if (hooks) {
        const text = result.content
          .filter((c: AgentToolResult<unknown>["content"][number]): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");
        await hooks.emit("after_tool_call", { agentId, toolName: t.name, args: params, result: text });
      }
      return result;
    },
  };
}

export async function createPiSession(
  deps: PiSessionDeps,
  opts: { agent: RegisteredAgent; sessionId: string; cwd?: string; extraSystemPrompt?: string },
): Promise<AgentSession> {
  const { agent, sessionId, cwd, extraSystemPrompt } = opts;
  if (!agent.sessionStore) throw new Error(`pi runner: agent ${agent.id} requires a sessionStore`);
  const sessionManager = await agent.sessionStore.getSessionManager(sessionId);
  if (!sessionManager) throw new Error(`Session "${sessionId}" not found`);

  const customTools = deps.getAgentTools(agent.id).map((t) => toToolDefinition(t, deps.hooks, agent.id));

  const { session } = await createAgentSession({
    cwd: cwd ?? resolveAgentWorkspacePath(agent.config),
    agentDir: path.join(ISOTOPES_HOME, "agents", agent.id, "agent"),
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    model: resolveModel(deps.globalProvider, agent.config.model),
    // Disable SDK built-ins (read/bash/edit/write); customTools are unaffected.
    noTools: "builtin",
    customTools,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });

  const basePrompt = await buildAgentSystemPrompt(agent.config);
  const finalPrompt = extraSystemPrompt ? `${basePrompt}\n\n---\n\n${extraSystemPrompt}` : basePrompt;
  overrideSessionSystemPrompt(session, finalPrompt);
  return session;
}
