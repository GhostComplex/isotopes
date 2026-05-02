import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type AgentSession,
  type AuthStorage,
  type ModelRegistry,
  type ToolDefinition,
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

import type { AgentConfig, ProviderConfig } from "../../types.js";
import type { HookRegistry } from "../../../legacy/plugins/hooks.js";
import type { RegisteredAgent } from "../../types.js";
import { overrideSessionSystemPrompt } from "./system-prompt-override.js";
import { deriveAgentSystemPrompt } from "../../system-prompt.js";

const ISOTOPES_HOME = process.env.ISOTOPES_HOME || path.join(process.env.HOME || "/tmp", ".isotopes");
const DEFAULT_MODEL = "claude-opus-4-7";

function resolveModel(globalProvider: ProviderConfig, modelId?: string): Model<Api> {
  const provider = globalProvider.type as Parameters<typeof getModel>[0];
  const id = modelId ?? globalProvider.defaultModel ?? DEFAULT_MODEL;
  const model = getModel(provider, id as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
  if (!model) throw new Error(`Unknown ${provider} model: ${id}`);

  const proxyHeaders: Record<string, string> = { ...(globalProvider.headers ?? {}) };
  if (globalProvider.baseUrl && globalProvider.apiKey) {
    proxyHeaders.Authorization ??= `Bearer ${globalProvider.apiKey}`;
  }
  const hasProxyHeaders = Object.keys(proxyHeaders).length > 0;

  if (!globalProvider.baseUrl && !hasProxyHeaders) return model;

  return {
    ...model,
    id,
    ...(globalProvider.baseUrl ? { baseUrl: globalProvider.baseUrl } : {}),
    ...(hasProxyHeaders ? { headers: { ...(model.headers ?? {}), ...proxyHeaders } } : {}),
  };
}

interface CreatePiAgentSessionOptions {
  globalProvider: ProviderConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  agentConfig: AgentConfig;
  tools: AgentTool[];
  sessionManager: SessionManager;
  systemPrompt: string;
  cwd?: string;
  hooks?: HookRegistry;
}

// Promote AgentTool → ToolDefinition (the shape pi-coding-agent customTools wants).
// AgentTool has no ctx parameter on execute; ToolDefinition does. Inline thin shim.
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

async function createPiAgentSession(opts: CreatePiAgentSessionOptions): Promise<AgentSession> {
  const {
    globalProvider, authStorage, modelRegistry,
    agentConfig, tools,
    sessionManager, systemPrompt, cwd, hooks,
  } = opts;

  const model: Model<Api> = resolveModel(globalProvider, agentConfig.model);
  const agentDir = path.join(ISOTOPES_HOME, "agents", agentConfig.id, "agent");

  const customTools: ToolDefinition[] = tools.map((t) => toToolDefinition(t, hooks, agentConfig.id));

  const compactionEnabled = !!(agentConfig.compaction && agentConfig.compaction.mode !== "off");
  const compactionSettings = compactionEnabled
    ? {
        enabled: true,
        reserveTokens: agentConfig.compaction?.reserveTokens ?? 20_000,
        keepRecentTokens: 20_000,
      }
    : { enabled: false, reserveTokens: 20_000, keepRecentTokens: 20_000 };

  const settingsManager = SettingsManager.inMemory({ compaction: compactionSettings });

  const { session } = await createAgentSession({
    cwd: cwd ?? process.cwd(),
    agentDir,
    authStorage,
    modelRegistry,
    model,
    // SDK reads `tools` as an allowlist. Pass our names so SDK's built-in
    // `bash` (host shell) doesn't end up active when sandboxed.
    tools: customTools.map((t) => t.name).filter((n): n is string => typeof n === "string"),
    customTools,
    sessionManager,
    settingsManager,
  });

  overrideSessionSystemPrompt(session, systemPrompt);

  return session;
}

export interface PiSessionDeps {
  globalProvider: ProviderConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  getAgentTools: (agentId: string) => AgentTool[];
  hooks?: HookRegistry;
}

export async function createRootPiSession(
  deps: PiSessionDeps,
  opts: { agent: RegisteredAgent; sessionId: string; cwd?: string; tools?: AgentTool[] },
): Promise<AgentSession> {
  const { agent, sessionId, cwd } = opts;
  const sessionManager = agent.sessionStore
    ? await agent.sessionStore.getSessionManager(sessionId)
    : SessionManager.inMemory();
  if (!sessionManager) throw new Error(`Session "${sessionId}" not found`);

  return createPiAgentSession({
    globalProvider: deps.globalProvider,
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    agentConfig: agent.config,
    tools: opts.tools ?? deps.getAgentTools(agent.id),
    sessionManager,
    systemPrompt: await deriveAgentSystemPrompt(agent.config),
    ...(cwd ? { cwd } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
  });
}
