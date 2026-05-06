import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  type AgentSession,
  type AuthStorage,
  type ModelRegistry,
  type ToolDefinition,
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

import type { ProviderConfig, RegisteredAgent } from "../../types.js";
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
  extensionPaths?: string[];
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

function toToolDefinition(t: AgentTool): ToolDefinition {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    ...(t.prepareArguments ? { prepareArguments: t.prepareArguments } : {}),
    ...(t.executionMode ? { executionMode: t.executionMode } : {}),
    execute: async (toolCallId, params, signal, onUpdate, _ctx) =>
      t.execute(toolCallId, params, signal, onUpdate),
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

  const customTools = deps.getAgentTools(agent.id).map(toToolDefinition);
  const sessionCwd = cwd ?? resolveAgentWorkspacePath(agent.config);
  const agentDir = path.join(ISOTOPES_HOME, "agents", agent.id, "agent");
  const settingsManager = SettingsManager.inMemory();

  let resourceLoader: DefaultResourceLoader | undefined;
  if (deps.extensionPaths && deps.extensionPaths.length > 0) {
    resourceLoader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: deps.extensionPaths,
    });
    await resourceLoader.reload();
  }

  const { session } = await createAgentSession({
    cwd: sessionCwd,
    agentDir,
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    model: resolveModel(deps.globalProvider, agent.config.model),
    noTools: "builtin",
    customTools,
    sessionManager,
    settingsManager,
    ...(resourceLoader ? { resourceLoader } : {}),
  });

  const basePrompt = await buildAgentSystemPrompt(agent.config);
  const finalPrompt = extraSystemPrompt ? `${basePrompt}\n\n---\n\n${extraSystemPrompt}` : basePrompt;
  overrideSessionSystemPrompt(session, finalPrompt);
  return session;
}
