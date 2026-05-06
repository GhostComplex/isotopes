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

/** Per-agent loader cache; reload() jiti-imports every extension file. */
const loaderCache = new Map<string, Promise<DefaultResourceLoader>>();

async function getResourceLoader(
  agentId: string,
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  extensionPaths: string[],
): Promise<DefaultResourceLoader> {
  const existing = loaderCache.get(agentId);
  if (existing) return existing;
  const init = (async () => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: extensionPaths,
    });
    await loader.reload();
    return loader;
  })();
  loaderCache.set(agentId, init);
  return init;
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
    resourceLoader = await getResourceLoader(
      agent.id,
      sessionCwd,
      agentDir,
      settingsManager,
      deps.extensionPaths,
    );
  }

  // Extension tools bypass tools.allow/deny unless we pass pi an allowlist.
  let toolAllowlist: string[] | undefined;
  const policy = agent.config.toolSettings;
  if (policy?.allow || policy?.deny) {
    const extensionToolNames: string[] = [];
    if (resourceLoader) {
      for (const ext of resourceLoader.getExtensions().extensions) {
        for (const name of ext.tools.keys()) extensionToolNames.push(name);
      }
    }
    const allNames = [...customTools.map((t) => t.name), ...extensionToolNames];
    const denySet = policy.deny ? new Set(policy.deny) : undefined;
    const allowSet = policy.allow ? new Set(policy.allow) : undefined;
    toolAllowlist = allNames.filter((n) => {
      if (denySet?.has(n)) return false;
      if (allowSet && !allowSet.has(n)) return false;
      return true;
    });
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
    ...(toolAllowlist ? { tools: toolAllowlist } : {}),
  });

  const basePrompt = await buildAgentSystemPrompt(agent.config);
  const finalPrompt = extraSystemPrompt ? `${basePrompt}\n\n---\n\n${extraSystemPrompt}` : basePrompt;
  overrideSessionSystemPrompt(session, finalPrompt);
  return session;
}
