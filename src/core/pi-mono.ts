// src/core/pi-mono.ts — Agent session factory backed by pi-coding-agent SDK
//
// Replaces the old PiMonoCore/PiMonoInstance with createAgentSession().
// Model resolution is handled here; compaction, overflow recovery, and
// event streaming are all delegated to the SDK's AgentSession.

import { type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
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

function toAgentTool(tool: Tool, handler: (args: unknown) => Promise<string>): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as AgentTool["parameters"],
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
  readonly tools: AgentTool[];
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

    // Convert registered tools
    this.tools = [];
    if (toolRegistry) {
      for (const entry of toolRegistry.list()) {
        const toolEntry = toolRegistry.get(entry.name);
        if (toolEntry) {
          this.tools.push(toAgentTool(toolEntry.tool, toolEntry.handler));
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
          reserveTokens: this.compactionConfig.reserveTokens ?? 16_384,
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
      tools: this.tools,
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

  /**
   * @deprecated Use createServiceCache() instead. This creates a backward-compatible
   * PiMonoInstance wrapper for consumers not yet migrated to AgentSession.
   */
  createAgent(config: AgentConfig): PiMonoInstance {
    const cache = this.createServiceCache(config);
    return new PiMonoInstance(cache, config);
  }
}

// ---------------------------------------------------------------------------
// PiMonoInstance — backward-compatible wrapper around AgentServiceCache
//
// Provides the same AsyncIterable<AgentEvent> interface as the old
// PiMonoInstance by wrapping AgentSession.subscribe() + prompt().
// Consumers should migrate to using AgentSession directly.
// ---------------------------------------------------------------------------

export class PiMonoInstance {
  private activeSession?: AgentSession;
  private promptQueue: Promise<void> = Promise.resolve();

  constructor(
    private cache: AgentServiceCache,
    private config: AgentConfig,
  ) {}

  async *prompt(input: string | AgentMessage[]): AsyncIterable<AgentEvent> {
    let releaseQueue: (() => void) | undefined;
    const waitForTurn = this.promptQueue.catch(() => undefined);
    this.promptQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await waitForTurn;

    try {
      // Create a temporary session with an in-memory SessionManager
      const sessionManager = SessionManager.open(
        path.join(this.cache.agentDir, "tmp-session.jsonl"),
      );

      const session = await this.cache.createSession({
        sessionManager,
        systemPrompt: this.config.systemPrompt,
      });

      this.activeSession = session;

      // If input is messages, load them into the session
      if (Array.isArray(input)) {
        session.agent.state.messages = input;
      }

      // Bridge AgentSession events to AsyncIterable<AgentEvent>
      yield* this.bridgeSessionEvents(session, typeof input === "string" ? input : undefined);
    } finally {
      this.activeSession?.dispose();
      this.activeSession = undefined;
      releaseQueue?.();
    }
  }

  private async *bridgeSessionEvents(
    session: AgentSession,
    textInput?: string,
  ): AsyncIterable<AgentEvent> {
    const events: (AgentEvent | null)[] = [];
    let resolve: (() => void) | null = null;

    const unsub = session.subscribe((e: AgentSessionEvent) => {
      // AgentSessionEvent is a superset of AgentEvent — forward matching types
      if ("type" in e && isAgentEvent(e)) {
        events.push(e as AgentEvent);
        resolve?.();
      }
    });

    const done = (async () => {
      if (textInput) {
        await session.prompt(textInput);
      } else {
        // Messages already loaded, trigger a turn by sending empty follow-up
        // Actually for message-based input the agent should already have messages set.
        // We need to trigger the agent loop. Use the Agent directly.
        await session.agent.prompt([]);
      }
    })().then(
      () => { events.push(null); resolve?.(); },
      (err) => { events.push(null); resolve?.(); throw err; },
    );

    try {
      let finished = false;
      while (!finished) {
        if (events.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }
        while (events.length > 0) {
          const ev = events.shift()!;
          if (ev === null) { finished = true; break; }
          yield ev;
        }
      }
      await done;
    } finally {
      unsub();
    }
  }

  abort(): void {
    this.activeSession?.abort();
  }

  steer(msg: AgentMessage): void {
    if (this.activeSession) {
      const text = extractText(msg);
      if (text) this.activeSession.steer(text);
    }
  }

  followUp(msg: AgentMessage): void {
    if (this.activeSession) {
      const text = extractText(msg);
      if (text) this.activeSession.followUp(text);
    }
  }

  clearMessages(): void {
    // No-op — sessions are per-prompt now
  }

  getMessages(): AgentMessage[] {
    return this.activeSession?.messages ?? [];
  }

  async forceCompact(): Promise<boolean> {
    if (!this.activeSession) return false;
    try {
      await this.activeSession.compact();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

function isAgentEvent(e: { type: string }): boolean {
  return AGENT_EVENT_TYPES.has(e.type);
}

function extractText(msg: AgentMessage): string | undefined {
  const m = msg as unknown as { content?: unknown };
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
        return (block as { text: string }).text;
      }
    }
  }
  return undefined;
}
