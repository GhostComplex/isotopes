// src/agent/runners/pi/session-factory.ts — Build a pi-coding-agent AgentSession
// for a given (agent, tools, sessionManager) per turn. Replaces the
// AgentServiceCache.createSession() method that lived in the deleted pi-mono.ts.

import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  type AuthStorage,
  type ModelRegistry,
  type SessionManager,
  type ToolDefinition,
  createAgentSession,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

import type { AgentConfig, ProviderConfig } from "../../types.js";
import type { Tool } from "../../../tools/types.js";
import type { ToolHandler } from "../../../legacy/core/tools.js";
import type { HookRegistry } from "../../../legacy/plugins/hooks.js";
import { overrideSessionSystemPrompt } from "./system-prompt-override.js";
import { wrapAgentTool } from "./tool-wrap.js";

const ISOTOPES_HOME = process.env.ISOTOPES_HOME || path.join(process.env.HOME || "/tmp", ".isotopes");
const DEFAULT_MODEL = "claude-opus-4.7";

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

export interface CreatePiAgentSessionOptions {
  globalProvider: ProviderConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  agentConfig: AgentConfig;
  /** Per-agent tool entries — wrapped per call so wrappers can pull per-call ctx. */
  tools: Array<{ tool: Tool; handler: ToolHandler }>;
  sessionManager: SessionManager;
  systemPrompt: string;
  cwd?: string;
  hooks?: HookRegistry;
}

export async function createPiAgentSession(opts: CreatePiAgentSessionOptions): Promise<AgentSession> {
  const {
    globalProvider, authStorage, modelRegistry,
    agentConfig, tools,
    sessionManager, systemPrompt, cwd, hooks,
  } = opts;

  const model: Model<Api> = resolveModel(globalProvider, agentConfig.model);
  const agentDir = path.join(ISOTOPES_HOME, "agents", agentConfig.id, "agent");

  const customTools: ToolDefinition[] = tools.map((entry) =>
    wrapAgentTool(entry, { hooks, agentId: agentConfig.id }),
  );

  const compactionEnabled = !!(agentConfig.compaction && agentConfig.compaction.mode !== "off");
  const compactionSettings = compactionEnabled
    ? {
        enabled: true,
        reserveTokens: agentConfig.compaction?.reserveTokens ?? 20_000,
        keepRecentTokens: 20_000,
      }
    : { enabled: false, reserveTokens: 20_000, keepRecentTokens: 20_000 };

  const settingsManager = SettingsManager.inMemory({ compaction: compactionSettings });

  // We do NOT pass an explicit DefaultResourceLoader: the SDK's built-in default
  // handles tool/extension wiring fine, and routing the prompt through the loader
  // couples us to its auto-discovery side effects (e.g. AGENTS.md/CLAUDE.md leak,
  // issue #590). Patching the session's system prompt after creation keeps prompt
  // injection isolated from loader behavior.
  const { session } = await createAgentSession({
    cwd: cwd ?? process.cwd(),
    agentDir,
    authStorage,
    modelRegistry,
    model,
    tools: [],
    customTools,
    sessionManager,
    settingsManager,
  });

  overrideSessionSystemPrompt(session, systemPrompt);

  return session;
}
