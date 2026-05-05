import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolSettings } from "../tools/types.js";
import { HostFs, SandboxFs, type FsBridge } from "../sandbox/fs-bridge.js";
import { SandboxExecutor } from "../sandbox/executor.js";
import { type SandboxConfig, shouldSandbox } from "../sandbox/config.js";
import { createWebFetchTool, createWebSearchTool } from "../legacy/tools/web.js";
import { createReactTools, type LazyTransportContext } from "../legacy/tools/react.js";
import { createExecTools, ProcessRegistry } from "../legacy/tools/exec.js";
import type { AgentRuntime } from "./runtime.js";
import { RunValidationError } from "./types.js";
import type { RunRequest } from "./types.js";
import { getMessageContext } from "../legacy/transport/context.js";
import { getDiscordA2AStreamContext } from "../legacy/plugins/discord/a2a-stream-context.js";
import { DiscordA2ASink } from "../legacy/plugins/discord/discord-a2a-sink.js";
import { getAgentEndMeta } from "./runners/pi/messages.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("tools");


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

const timeSchema = Type.Object({
  timezone: Type.Optional(
    Type.String({ description: "IANA timezone (e.g., 'Asia/Shanghai'). Defaults to UTC." }),
  ),
});

export function createTimeTool(): AgentTool<typeof timeSchema> {
  return {
    name: "get_current_time",
    label: "get_current_time",
    description: "Returns the current date and time",
    parameters: timeSchema,
    execute: async (_id, { timezone }) => {
      const now = new Date();
      if (timezone) {
        try {
          return textResult(now.toLocaleString("en-US", { timeZone: timezone }));
        } catch {
          return textResult(`Invalid timezone: ${timezone}. Current UTC: ${now.toISOString()}`);
        }
      }
      return textResult(now.toISOString());
    },
  };
}

// ---------------------------------------------------------------------------
// spawn_agent
// ---------------------------------------------------------------------------

export interface SpawnAgentToolOptions {
  runtime: AgentRuntime;
  parentAgentId: string;
  workspacePath: string;
  allowedAgents?: string[];
  spawnableAgentIds?: string[];
}

export function createSpawnAgentTool(options: SpawnAgentToolOptions): AgentTool {
  const { runtime, parentAgentId, workspacePath, allowedAgents, spawnableAgentIds } = options;
  const computedTargets: string[] = [...runtime.spawnableRunnerNames()];
  if (spawnableAgentIds) {
    for (const id of spawnableAgentIds) {
      if (id !== parentAgentId && !computedTargets.includes(id)) computedTargets.push(id);
    }
  }
  const targets = allowedAgents ?? computedTargets;

  const schema = Type.Object({
    to: targets.length > 0
      ? Type.Union(targets.map((t) => Type.Literal(t)), {
          description: `Target agent id. Options: ${targets.join(", ")}.`,
        })
      : Type.String({ description: "Target agent id (no targets configured)." }),
    content: Type.String({ description: "Message content to deliver as the user-role turn." }),
    working_directory: Type.Optional(Type.String({
      description:
        "Working directory to convey to the target. Required for `coding` " +
        "(sets the claude subprocess cwd). For pi agents (subagent, registered ones), " +
        "passed in the prompt as task context — the agent uses absolute paths if it cares.",
    })),
  });

  type Params = {
    to: string;
    content: string;
    working_directory?: string;
  };

  return {
    name: "spawn_agent",
    label: "spawn_agent",
    description:
      `Spawn another agent to handle a focused task and synchronously await its final reply. ` +
      `Available targets: ${targets.join(", ") || "(none)"}. ` +
      "For `subagent`, an ephemeral helper runs with read-only tools. " +
      "For `coding`, a Claude CLI session runs against `working_directory`. " +
      "For a registered agent id, the prompt is appended to that agent's session as a user-role turn. " +
      "Session continuity for registered agents is managed by the runtime (per caller / parent-session). " +
      "This call blocks until the spawned agent finishes; the return value is its final assistant message.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Params;
      const { to, content, working_directory } = params;
      if (!targets.includes(to)) {
        return textResult(`[error] Unknown target: ${to}. Available: ${targets.join(", ")}`);
      }
      const isRunner = runtime.hasRunner(to);
      const cwd = working_directory
        ? path.resolve(workspacePath, working_directory)
        : workspacePath;
      const ctx = getMessageContext();

      let cancelReason: string | undefined;
      const req: RunRequest = {
        to,
        content,
        cwd,
        from: { agentId: parentAgentId },
        ...(ctx?.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
        onCancel: (reason) => { cancelReason = reason; },
      };
      log.info("spawn_agent", { from: parentAgentId, to, cwd, parent: ctx?.parentSessionId });

      const discordCtx = getDiscordA2AStreamContext();
      let sink: DiscordA2ASink | undefined;
      const startedAt = Date.now();
      const taskLabel = `${to}: ${content.slice(0, 80)}${content.length > 80 ? "…" : ""}`;

      req.onRunStart = (sessionId: string) => {
        if (discordCtx) {
          const showToolCalls = discordCtx.showToolCalls ?? true;
          sink = new DiscordA2ASink(discordCtx, sessionId, { showToolCalls });
          void sink.start(taskLabel);
        }
      };

      let assistantText = "";
      let errorMessage: string | null = null;
      try {
        for await (const event of runtime.run(req)) {
          if (sink) await sink.sendEvent(event);
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") assistantText += ame.delta;
          } else if (event.type === "agent_end") {
            const meta = getAgentEndMeta(event.messages);
            if (meta.stopReason === "error") {
              errorMessage = meta.errorMessage ?? "Unknown agent error";
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof RunValidationError) {
          if (sink) await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
          return textResult(`[error] ${msg}`);
        }
        if (sink) await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
        return textResult(`[spawn_agent failed] ${msg}`);
      }

      if (cancelReason === "user") {
        if (sink) await sink.finish({ success: false, error: "cancelled by user", durationMs: Date.now() - startedAt });
        return textResult(`[spawn_agent cancelled by user — do not retry this same request]`);
      }

      if (sink) {
        await sink.finish({
          success: !errorMessage,
          ...(assistantText.trim() ? { output: assistantText.trim() } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
          durationMs: Date.now() - startedAt,
        });
      }
      if (errorMessage) {
        return textResult(`[spawn_agent failed] ${errorMessage}`);
      }
      const trimmed = assistantText.trim();
      return textResult(trimmed.length > 0 ? trimmed : (isRunner ? `[${to} completed with no output]` : "[no reply]"));
    },
  };
}

// ---------------------------------------------------------------------------
// SDK file tools — read/write/edit/ls
// ---------------------------------------------------------------------------

function createFsTools(workspacePath: string, fs: FsBridge): AgentTool[] {
  return [
    createReadTool(workspacePath, {
      operations: {
        readFile: (p) => fs.readFile(p),
        access: (p) => fs.access(p),
      },
    }) as AgentTool,
    createWriteTool(workspacePath, {
      operations: {
        writeFile: (p, c) => fs.writeFile(p, c),
        mkdir: (d) => fs.mkdir(d),
      },
    }) as AgentTool,
    createEditTool(workspacePath, {
      operations: {
        readFile: (p) => fs.readFile(p),
        writeFile: (p, c) => fs.writeFile(p, c),
        access: (p) => fs.access(p),
      },
    }) as AgentTool,
    createLsTool(workspacePath, {
      operations: {
        exists: (p) => fs.exists(p),
        stat: (p) => fs.stat(p),
        readdir: (p) => fs.readdir(p),
      },
    }) as AgentTool,
  ];
}

// ---------------------------------------------------------------------------
// Tool policy — per-agent allow/deny filtering
// ---------------------------------------------------------------------------

export function applyToolPolicy(
  tools: AgentTool[],
  policy?: { allow?: string[]; deny?: string[] },
): AgentTool[] {
  if (!policy) return tools;
  const { allow, deny } = policy;
  if (!allow && !deny) return tools;
  const denySet = deny ? new Set(deny) : undefined;
  const allowSet = allow ? new Set(allow) : undefined;
  return tools.filter((t) => {
    if (denySet?.has(t.name)) return false;
    if (allowSet && !allowSet.has(t.name)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Agent tool set
// ---------------------------------------------------------------------------

export interface CreateAgentToolsOptions {
  workspacePath: string;
  agentId: string;
  settings?: AgentToolSettings;
  parentAgentId?: string;
  /** Required for the spawn_agent tool. */
  runtime?: AgentRuntime;
  /** Pre-computed list of registered agent ids the LLM can address. */
  spawnableAgentIds?: string[];
  transportContext?: LazyTransportContext;
  processRegistry: ProcessRegistry;
  /** When defined and resolves to a sandboxed mode, FS and exec route through
   *  docker; spawn_agent is also disabled (host child runners can't be
   *  confined). Search needs (find/grep) go through `exec` with `fd`/`rg`. */
  agentSandboxConfig?: SandboxConfig;
}

/**
 * The single SandboxExecutor instance shared by all sandboxed agents.
 * Set once at boot via `configureToolsLayer`. Module-state matches reality:
 * one daemon, one ContainerManager, one SandboxExecutor.
 */
let sandboxExecutorSingleton: SandboxExecutor | undefined;

export function configureToolsLayer(opts: { sandboxExecutor?: SandboxExecutor }): void {
  sandboxExecutorSingleton = opts.sandboxExecutor;
}

export function createAgentTools(opts: CreateAgentToolsOptions): AgentTool[] {
  const isSandboxed = !!(sandboxExecutorSingleton && opts.agentSandboxConfig
    && shouldSandbox(opts.agentSandboxConfig, false));
  const fs: FsBridge = isSandboxed
    ? new SandboxFs(sandboxExecutorSingleton!, opts.agentId)
    : new HostFs();
  const spawnAgentEnabled = !isSandboxed;
  if (isSandboxed) {
    log.warn(`spawn_agent tool disabled for ${opts.agentId}: sandbox is active and child runners cannot be confined.`);
  }

  const tools: AgentTool[] = [
    ...createFsTools(opts.workspacePath, fs),
    createTimeTool(),
    ...createExecTools({
      cwd: opts.workspacePath,
      registry: opts.processRegistry,
      sandboxExecutor: sandboxExecutorSingleton,
      agentId: opts.agentId,
      isMainAgent: false,
      agentSandboxConfig: opts.agentSandboxConfig,
    }),
  ];
  if (spawnAgentEnabled && opts.runtime && opts.parentAgentId) {
    tools.push(createSpawnAgentTool({
      runtime: opts.runtime,
      parentAgentId: opts.parentAgentId,
      workspacePath: opts.workspacePath,
      ...(opts.spawnableAgentIds ? { spawnableAgentIds: opts.spawnableAgentIds } : {}),
    }));
  }
  if (opts.settings?.web) {
    tools.push(createWebFetchTool());
    tools.push(createWebSearchTool());
  }
  if (opts.transportContext) {
    tools.push(...createReactTools(opts.transportContext));
  }

  return applyToolPolicy(tools, opts.settings);
}
