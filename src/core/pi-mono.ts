// src/core/pi-mono.ts — Agent session factory backed by pi-coding-agent SDK
//
// Model resolution and AgentServiceCache (cached SDK dependencies per agent).
// Compaction, overflow recovery, and event streaming are all delegated to
// the SDK's AgentSession.

import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import {
  type AgentConfig,
  type CompactionConfig,
  type Tool,
} from "./types.js";
import type { ToolRegistry } from "./tools.js";
import { resolveCompactionConfig } from "./compaction.js";
import { createLogger } from "./logger.js";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { AgentSession } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-opus-4.5";
const log = createLogger("pi-mono");

function cloneModel<TApi extends Api>(
  model: Model<TApi>,
  overrides: Partial<Pick<Model<TApi>, "id" | "name" | "baseUrl" | "headers">>,
): Model<TApi> {
  return {
    id: overrides.id ?? model.id,
    name: overrides.name ?? model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: overrides.baseUrl ?? model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...((model.headers || overrides.headers)
      ? { headers: { ...(model.headers ?? {}), ...(overrides.headers ?? {}) } }
      : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function resolveKnownModel(
  provider: Parameters<typeof getModel>[0],
  modelId: string,
): Model<Api> {
  const model = getModel(provider, modelId as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
  if (model) return model;

  if (provider === "anthropic") {
    const dashed = modelId.replace(/(claude-(?:opus|sonnet|haiku)-\d)\.(\d)/g, "$1-$2");
    if (dashed !== modelId) {
      const aliased = getModel(provider, dashed as Parameters<typeof getModel>[1]) as Model<Api> | undefined;
      if (aliased) return aliased;
    }
  }

  throw new Error(`Unknown ${provider} model: ${modelId}`);
}

export function resolveModel(config: AgentConfig): Model<Api> {
  const p = config.provider;
  const provider = (p?.type.replace(/-proxy$/, "") ?? "anthropic") as Parameters<typeof getModel>[0];
  const modelId = p?.model ?? DEFAULT_MODEL;
  const model = resolveKnownModel(provider, modelId);

  const proxyHeaders = { ...(p?.headers ?? {}) };
  if (p?.type === "anthropic-proxy" && p.apiKey) {
    proxyHeaders.Authorization ??= `Bearer ${p.apiKey}`;
  }
  const headers = Object.keys(proxyHeaders).length > 0
    ? { ...(model.headers ?? {}), ...proxyHeaders }
    : undefined;

  if (p?.baseUrl || headers) {
    return cloneModel(model, { id: modelId, baseUrl: p?.baseUrl, headers });
  }

  return model;
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

function toToolDefinition(tool: Tool, handler: (args: unknown) => Promise<string>): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as ToolDefinition["parameters"],
    label: tool.name,
    execute: async (_toolCallId, params) => {
      const result = await handler(params);
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// AgentServiceCache — cached per-agent SDK dependencies
// ---------------------------------------------------------------------------

const ISOTOPES_HOME = process.env.ISOTOPES_HOME || path.join(process.env.HOME || "/tmp", ".isotopes");

export interface AgentServiceCacheConfig {
  agentConfig: AgentConfig;
  toolRegistry?: ToolRegistry;
}

export class AgentServiceCache {
  readonly model: Model<Api>;
  readonly customTools: ToolDefinition[];
  readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly compactionConfig?: CompactionConfig;
  private readonly apiKey: string;

  constructor(opts: AgentServiceCacheConfig) {
    const { agentConfig, toolRegistry } = opts;

    this.model = resolveModel(agentConfig);
    this.agentDir = path.join(ISOTOPES_HOME, "agents", agentConfig.id, "agent");
    this.apiKey = agentConfig.provider?.apiKey ?? "";

    // Build in-memory auth storage with the provider's API key
    const provider = (agentConfig.provider?.type.replace(/-proxy$/, "") ?? "anthropic") as string;
    const creds: Record<string, { type: "api_key"; key: string }> = {};
    if (this.apiKey) {
      creds[provider] = { type: "api_key", key: this.apiKey };
    }
    this.authStorage = AuthStorage.inMemory(creds);
    this.modelRegistry = ModelRegistry.create(this.authStorage);

    // Convert registered tools to ToolDefinition for the SDK
    this.customTools = [];
    if (toolRegistry) {
      for (const entry of toolRegistry.list()) {
        const toolEntry = toolRegistry.get(entry.name);
        if (toolEntry) {
          this.customTools.push(toToolDefinition(toolEntry.tool, toolEntry.handler));
        }
      }
    }

    // Resolve compaction config
    if (agentConfig.compaction && agentConfig.compaction.mode !== "off") {
      this.compactionConfig = resolveCompactionConfig(agentConfig.compaction);
      log.info(`Context compaction enabled for agent "${agentConfig.id}" (mode: ${this.compactionConfig.mode})`);
    }
  }

  /**
   * Create a new AgentSession for a specific conversation.
   * The session manages its own compaction and overflow recovery.
   */
  async createSession(opts: {
    sessionManager: SessionManager;
    systemPrompt: string;
    cwd?: string;
  }): Promise<AgentSession> {
    const compactionSettings = this.compactionConfig
      ? {
          enabled: true,
          reserveTokens: this.compactionConfig.reserveTokens ?? 20_000,
          keepRecentTokens: 20_000,
        }
      : { enabled: false, reserveTokens: 20_000, keepRecentTokens: 20_000 };

    const settingsManager = SettingsManager.inMemory({
      compaction: compactionSettings,
    });

    const { session } = await createAgentSession({
      cwd: opts.cwd ?? process.cwd(),
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model: this.model,
      tools: [],
      customTools: this.customTools,
      sessionManager: opts.sessionManager,
      settingsManager,
    });

    session.agent.state.systemPrompt = opts.systemPrompt;

    return session;
  }
}

// ---------------------------------------------------------------------------
// PiMonoCore — tool registry management + AgentServiceCache factory
// ---------------------------------------------------------------------------

export class PiMonoCore {
  private toolRegistries = new Map<string, ToolRegistry>();

  setToolRegistry(agentId: string, registry: ToolRegistry): void {
    this.toolRegistries.set(agentId, registry);
  }

  clearToolRegistry(agentId: string): void {
    this.toolRegistries.delete(agentId);
  }

  createServiceCache(config: AgentConfig): AgentServiceCache {
    return new AgentServiceCache({
      agentConfig: config,
      toolRegistry: this.toolRegistries.get(config.id),
    });
  }

}
