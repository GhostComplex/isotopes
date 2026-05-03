import path from "node:path";
import * as nodeFs from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolSettings } from "../../tools/types.js";
import type { SandboxFs } from "../sandbox/fs-bridge.js";
import type { SandboxExecutor } from "../sandbox/executor.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { createWebFetchTool, createWebSearchTool } from "../tools/web.js";
import { createReactTools, type LazyTransportContext } from "../tools/react.js";
import { createExecTools, ProcessRegistry } from "../tools/exec.js";
import type { AgentRuntime } from "../../agent/runtime.js";
import { RunValidationError } from "../../agent/types.js";
import type { RunRequest } from "../../agent/types.js";
import { getMessageContext } from "../transport/context.js";
import { getDiscordA2AStreamContext } from "../plugins/discord/a2a-stream-context.js";
import { DiscordA2ASink } from "../plugins/discord/discord-a2a-sink.js";
import { getAgentEndMeta } from "../../agent/runners/pi/messages.js";
import { createLogger } from "../../logging/logger.js";

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

const echoSchema = Type.Object({
  message: Type.String({ description: "The message to echo" }),
});

export function createEchoTool(): AgentTool<typeof echoSchema> {
  return {
    name: "echo",
    label: "echo",
    description: "Echoes the input message back",
    parameters: echoSchema,
    execute: async (_id, { message }) => textResult(message),
  };
}

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
// Agent
// ---------------------------------------------------------------------------

export interface CallAgentToolOptions {
  runtime: AgentRuntime;
  parentAgentId: string;
  workspacePath: string;
  allowedAgents?: string[];
  spawnableAgentIds?: string[];
}

export function createCallAgentTool(options: CallAgentToolOptions): AgentTool {
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
      `Send a message to another agent. Available targets: ${targets.join(", ") || "(none)"}. ` +
      "For `subagent`, an ephemeral helper runs with read-only tools and returns its " +
      "final assistant message. For `coding`, a Claude CLI session runs against " +
      "`working_directory` and returns its final assistant message. For a registered agent id, " +
      "the message is appended to that agent's session as a user-role turn and its reply is returned. " +
      "Session continuity for registered agents is managed by the runtime (per caller / parent-session).",
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

type FsImpl = SandboxFs | typeof nodeFs;

function createFsTools(workspacePath: string, fsImpl: FsImpl): AgentTool[] {
  const access = (p: string) => fsImpl.stat(p).then(() => undefined);
  return [
    createReadTool(workspacePath, {
      operations: {
        readFile: (p) => fsImpl.readFile(p) as Promise<Buffer>,
        access,
      },
    }) as AgentTool,
    createWriteTool(workspacePath, {
      operations: {
        writeFile: (p, c) => fsImpl.writeFile(p, c, "utf-8"),
        mkdir: (d) => fsImpl.mkdir(d, { recursive: true }).then(() => undefined),
      },
    }) as AgentTool,
    createEditTool(workspacePath, {
      operations: {
        readFile: (p) => fsImpl.readFile(p) as Promise<Buffer>,
        writeFile: (p, c) => fsImpl.writeFile(p, c, "utf-8"),
        access,
      },
    }) as AgentTool,
    createLsTool(workspacePath, {
      operations: {
        exists: (p) => fsImpl.stat(p).then(() => true).catch(() => false),
        stat: (p) => fsImpl.stat(p),
        readdir: (p) => fsImpl.readdir(p) as Promise<string[]>,
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
// Workspace tool set
// ---------------------------------------------------------------------------

export interface CreateWorkspaceToolsOptions {
  workspacePath: string;
  settings?: AgentToolSettings;
  /** Register the `spawn_agent` tool. Requires `runtime` + `parentAgentId`. */
  callAgentEnabled?: boolean;
  fsImpl?: FsImpl;
  parentAgentId?: string;
  /** Unified runtime — required when callAgentEnabled is true. */
  runtime?: AgentRuntime;
  /** Pre-computed list of registered agent ids the LLM can address. */
  spawnableAgentIds?: string[];
}

export function createWorkspaceToolsWithGuards(options: CreateWorkspaceToolsOptions): AgentTool[] {
  const {
    workspacePath,
    settings,
    callAgentEnabled = false,
    fsImpl = nodeFs,
    parentAgentId,
    runtime,
    spawnableAgentIds,
  } = options;

  const tools: AgentTool[] = [
    ...createFsTools(workspacePath, fsImpl),
    createTimeTool(),
  ];
  if (callAgentEnabled && runtime && parentAgentId) {
    tools.push(createCallAgentTool({
      runtime,
      parentAgentId,
      workspacePath,
      ...(spawnableAgentIds ? { spawnableAgentIds } : {}),
    }));
  }
  if (settings?.web) {
    tools.push(createWebFetchTool());
    tools.push(createWebSearchTool());
  }
  return tools;
}

export interface CreateAgentToolsOptions extends CreateWorkspaceToolsOptions {
  transportContext?: LazyTransportContext;
  processRegistry: ProcessRegistry;
  sandboxExecutor?: SandboxExecutor;
  agentSandboxConfig?: SandboxConfig;
  allowedWorkspaces?: string[];
  agentId: string;
}

export function createAgentTools(opts: CreateAgentToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  tools.push(...applyToolPolicy(
    createWorkspaceToolsWithGuards(opts),
    opts.settings,
  ));
  if (opts.transportContext) {
    tools.push(...createReactTools(opts.transportContext));
  }
  tools.push(...applyToolPolicy(
    createExecTools({
      cwd: opts.workspacePath,
      registry: opts.processRegistry,
      sandboxExecutor: opts.sandboxExecutor,
      agentId: opts.agentId,
      isMainAgent: false,
      agentSandboxConfig: opts.agentSandboxConfig,
      allowedWorkspaces: opts.allowedWorkspaces ?? [],
    }),
    opts.settings,
  ));
  return tools;
}
