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
import { resolveAgentWorkspacePath } from "../../../paths.js";
import { resolveBundledSkillsDir } from "../../../legacy/skills/bundled-dir.js";
import { loadWorkspaceContext, buildSystemPrompt } from "../../workspace.js";

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
  opts: { agent: RegisteredAgent; sessionId: string; cwd?: string },
): Promise<AgentSession> {
  const { agent, sessionId, cwd } = opts;
  if (!agent.sessionStore) throw new Error(`pi runner: agent ${agent.id} requires a sessionStore`);
  const sessionManager = await agent.sessionStore.getSessionManager(sessionId);
  if (!sessionManager) throw new Error(`Session "${sessionId}" not found`);

  const customTools = deps.getAgentTools(agent.id).map((t) => toToolDefinition(t, deps.hooks, agent.id));
  const compactionEnabled = !!(agent.config.compaction && agent.config.compaction.mode !== "off");
  const settingsManager = SettingsManager.inMemory({
    compaction: compactionEnabled
      ? { enabled: true, reserveTokens: agent.config.compaction?.reserveTokens ?? 20_000, keepRecentTokens: 20_000 }
      : { enabled: false, reserveTokens: 20_000, keepRecentTokens: 20_000 },
  });

  const { session } = await createAgentSession({
    cwd: cwd ?? process.cwd(),
    agentDir: path.join(ISOTOPES_HOME, "agents", agent.id, "agent"),
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    model: resolveModel(deps.globalProvider, agent.config.model),
    // SDK reads `tools` as an allowlist; pass our names so the SDK's built-in
    // `bash` doesn't end up active alongside our customTools.
    tools: customTools.map((t) => t.name).filter((n): n is string => typeof n === "string"),
    customTools,
    sessionManager,
    settingsManager,
  });

  overrideSessionSystemPrompt(session, await deriveSystemPrompt(agent));
  return session;
}

async function deriveSystemPrompt(agent: RegisteredAgent): Promise<string> {
  const workspacePath = resolveAgentWorkspacePath(agent.config);
  const workspace = await loadWorkspaceContext(workspacePath, {
    bundledPath: resolveBundledSkillsDir(),
  });
  return buildSystemPrompt(workspace);
}
