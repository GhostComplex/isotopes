// src/core/pi-mono.ts — Agent session factory backed by pi-coding-agent SDK
//
// Model resolution and AgentServiceCache (cached SDK dependencies per agent).
// Compaction, overflow recovery, and event streaming are all delegated to
// the SDK's AgentSession.

import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import { truncateToolResultText } from "../../agent/runners/pi/tool-result-truncation.js";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import type { AgentConfig, CompactionConfig, ProviderConfig } from "../../agent/types.js";
import type { Tool } from "../../tools/types.js";
import type { ToolRegistry } from "./tools.js";
import { createLogger } from "../../logging/logger.js";
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

/**
 * Resolve a Model<Api> from the global provider config + an explicit model id.
 *
 * Per-agent provider override is no longer supported — agents pick `model`
 * only. The provider type / baseUrl / headers / apiKey come from the single
 * global ProviderConfig.
 */
export function resolveModel(globalProvider: ProviderConfig, modelId: string): Model<Api> {
  const provider = globalProvider.type as Parameters<typeof getModel>[0];
  const model = resolveKnownModel(provider, modelId);

  const proxyHeaders: Record<string, string> = { ...(globalProvider.headers ?? {}) };
  // For provider types whose pi-ai catalog model expects an explicit Authorization
  // header instead of pi-ai's built-in env auth, stamp the global apiKey here.
  // This was the old "*-proxy" behavior — now triggered by setting baseUrl + apiKey.
  if (globalProvider.baseUrl && globalProvider.apiKey) {
    proxyHeaders.Authorization ??= `Bearer ${globalProvider.apiKey}`;
  }
  const headers = Object.keys(proxyHeaders).length > 0
    ? { ...(model.headers ?? {}), ...proxyHeaders }
    : undefined;

  if (globalProvider.baseUrl || headers) {
    return cloneModel(model, { id: modelId, baseUrl: globalProvider.baseUrl, headers });
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
        content: [{ type: "text", text: truncateToolResultText(result) }],
        details: {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// System prompt override
// ---------------------------------------------------------------------------

/**
 * Force a system prompt onto an existing AgentSession by patching the SDK's
 * private fields.
 *
 * Three fields must be set together:
 *  - `state.systemPrompt`: what the LLM sees on the next turn
 *  - `_baseSystemPrompt`: SDK's prompt() handler resets state.systemPrompt
 *    to this value on every call when an extensionRunner exists
 *  - `_rebuildSystemPrompt`: SDK calls this when the tool list changes; we
 *    return the override so a rebuild does not overwrite our prompt
 *
 * The `as unknown as { ... }` cast is required because `_baseSystemPrompt`
 * and `_rebuildSystemPrompt` are private to the SDK's AgentSession class.
 * If the SDK renames these fields, this will fail loudly at the access site
 * (TypeScript will not catch it because of the cast — but the LLM will
 * immediately revert to its default identity, which is a visible regression).
 */
export function overrideSessionSystemPrompt(
  session: AgentSession,
  override: string,
): void {
  const prompt = override.trim();
  session.agent.state.systemPrompt = prompt;
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;
}

// ---------------------------------------------------------------------------
// AgentServiceCache — cached per-agent SDK dependencies
// ---------------------------------------------------------------------------

const ISOTOPES_HOME = process.env.ISOTOPES_HOME || path.join(process.env.HOME || "/tmp", ".isotopes");

export interface AgentServiceCacheConfig {
  agentConfig: AgentConfig;
  /** Single global provider — auth + api type. Per-agent override removed. */
  globalProvider: ProviderConfig;
  toolRegistry?: ToolRegistry;
}

export class AgentServiceCache {
  readonly model: Model<Api>;
  readonly customTools: ToolDefinition[];
  readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly compactionConfig?: CompactionConfig;

  constructor(opts: AgentServiceCacheConfig) {
    const { agentConfig, globalProvider, toolRegistry } = opts;

    const modelId = agentConfig.model ?? globalProvider.defaultModel ?? DEFAULT_MODEL;
    this.model = resolveModel(globalProvider, modelId);
    this.agentDir = path.join(ISOTOPES_HOME, "agents", agentConfig.id, "agent");

    // Build in-memory auth storage from the global provider's API key.
    // Provider key is the SDK provider name (e.g. "anthropic", "openai").
    const creds: Record<string, { type: "api_key"; key: string }> = {};
    if (globalProvider.apiKey) {
      creds[globalProvider.type] = { type: "api_key", key: globalProvider.apiKey };
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
      this.compactionConfig = agentConfig.compaction;
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

    // The SDK's prompt() handler resets `state.systemPrompt` back to
    // `_baseSystemPrompt` on every call when an extensionRunner exists
    // (always true with customTools). It may also call `_rebuildSystemPrompt`
    // when the tool list changes. To make the override stick, we patch all
    // three fields directly on the session after creation.
    //
    // We do NOT pass an explicit DefaultResourceLoader: the SDK's built-in
    // default loader handles tool/extension wiring fine, and routing the
    // prompt through the loader couples us to the loader's auto-discovery
    // side effects (e.g. AGENTS.md/CLAUDE.md leak — issue #590). Patching
    // the session directly keeps prompt injection isolated from loader behavior.
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

    overrideSessionSystemPrompt(session, opts.systemPrompt);

    return session;
  }
}

// ---------------------------------------------------------------------------
// PiMonoCore — tool registry management + AgentServiceCache factory
// ---------------------------------------------------------------------------

export class PiMonoCore {
  private toolRegistries = new Map<string, ToolRegistry>();

  /**
   * @param globalProvider — single provider config used for all agents
   *        (per-agent provider override is no longer supported)
   */
  constructor(private readonly globalProvider: ProviderConfig) {}

  setToolRegistry(agentId: string, registry: ToolRegistry): void {
    this.toolRegistries.set(agentId, registry);
  }

  clearToolRegistry(agentId: string): void {
    this.toolRegistries.delete(agentId);
  }

  createServiceCache(config: AgentConfig): AgentServiceCache {
    return new AgentServiceCache({
      agentConfig: config,
      globalProvider: this.globalProvider,
      toolRegistry: this.toolRegistries.get(config.id),
    });
  }

}
