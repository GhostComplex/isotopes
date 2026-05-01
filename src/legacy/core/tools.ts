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
import type { AgentRuntime } from "../agents/runtime.js";
import { SUBAGENT_AGENT_ID, CLAUDE_AGENT_ID, SendMessageValidationError } from "../agents/runtime.js";
import type { SendMessageRequest } from "../agents/types.js";
import { getMessageContext } from "../transport/context.js";
import { getDiscordSubagentStreamContext } from "../plugins/discord/subagent-stream-context.js";
import { DiscordSubagentSink } from "../plugins/discord/discord-subagent-sink.js";
import { failureTracker } from "../agents/failure-tracker.js";
import { getAgentEndMeta } from "../../agent/runners/pi/messages.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("tools");

export { SUBAGENT_AGENT_ID, CLAUDE_AGENT_ID };

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
// send_message
// ---------------------------------------------------------------------------

export interface SendMessageToolOptions {
  runtime: AgentRuntime;
  parentAgentId: string;
  workspacePath: string;
  parentTools?: AgentTool[];
  allowedAgents?: string[];
  spawnableAgentIds?: string[];
}

export function createSendMessageTool(options: SendMessageToolOptions): AgentTool {
  const { runtime, parentAgentId, workspacePath, parentTools, allowedAgents, spawnableAgentIds } = options;
  const computedTargets: string[] = [];
  if (parentTools) computedTargets.push(SUBAGENT_AGENT_ID);
  if (runtime.hasClaudeRunner()) computedTargets.push(CLAUDE_AGENT_ID);
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
        "Working directory for the target's session (relative to your workspace or absolute). " +
        "Required for `claude`; optional for others (defaults to your workspace root).",
    })),
    conversation_id: Type.Optional(Type.String({
      description:
        "Optional existing session id to resume. Only valid for registered agents " +
        "(not `subagent` or `claude`).",
    })),
  });

  type Params = {
    to: string;
    content: string;
    working_directory?: string;
    conversation_id?: string;
  };

  return {
    name: "send_message",
    label: "send_message",
    description:
      `Send a message to another agent. Available targets: ${targets.join(", ") || "(none)"}. ` +
      "For `subagent`, an ephemeral helper runs with your filtered tool set and returns its " +
      "final assistant message as the result. For `claude`, a Claude CLI session runs against " +
      "`working_directory` and returns its final assistant message. For a registered agent id, " +
      "the message is appended to that agent's session as a user-role turn and its reply is returned.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Params;
      const { to, content, working_directory, conversation_id } = params;
      if (!targets.includes(to)) {
        return textResult(`[error] Unknown target: ${to}. Available: ${targets.join(", ")}`);
      }
      const isSubagent = to === SUBAGENT_AGENT_ID;
      const isClaude = to === CLAUDE_AGENT_ID;
      const cwd = working_directory
        ? path.resolve(workspacePath, working_directory)
        : workspacePath;
      const ctx = getMessageContext();
      const callerSessionId = ctx?.parentSessionId;

      if (callerSessionId) {
        const block = failureTracker.shouldBlock(callerSessionId, content);
        if (block.blocked) {
          log.warn("send_message blocked", { from: parentAgentId, to, reason: block.reason });
          return textResult(`[blocked] ${block.reason}`);
        }
        failureTracker.recordSpawn(callerSessionId);
      }

      let cancelReason: string | undefined;
      const req: SendMessageRequest = {
        to,
        content,
        cwd,
        from: { agentId: parentAgentId },
        ...(conversation_id ? { sessionId: conversation_id } : {}),
        ...(ctx?.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
        ...(isSubagent && parentTools ? { leafContext: { tools: parentTools } } : {}),
        onCancel: (reason) => { cancelReason = reason; },
      };
      log.info("send_message", { from: parentAgentId, to, cwd, hasConversation: !!conversation_id, parent: ctx?.parentSessionId });

      const discordCtx = getDiscordSubagentStreamContext();
      let sink: DiscordSubagentSink | undefined;
      const startedAt = Date.now();
      const taskLabel = `${to}: ${content.slice(0, 80)}${content.length > 80 ? "…" : ""}`;

      req.onRunStart = (runId: string) => {
        if (discordCtx) {
          const showToolCalls = discordCtx.showToolCalls ?? true;
          sink = new DiscordSubagentSink(discordCtx, runId, { showToolCalls });
          void sink.start(taskLabel);
        }
      };

      let assistantText = "";
      let errorMessage: string | null = null;
      try {
        for await (const event of runtime.sendMessage(req)) {
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
        if (err instanceof SendMessageValidationError) {
          if (sink) await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
          return textResult(`[error] ${msg}`);
        }
        if (sink) await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
        if (callerSessionId) failureTracker.recordFailure(callerSessionId, content, msg);
        return textResult(`[send_message failed] ${msg}`);
      }

      if (cancelReason === "user") {
        if (callerSessionId) failureTracker.recordCancel(callerSessionId, content);
        if (sink) await sink.finish({ success: false, error: "cancelled by user", durationMs: Date.now() - startedAt });
        return textResult(`[send_message cancelled by user — do not retry this same request]`);
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
        if (callerSessionId) failureTracker.recordFailure(callerSessionId, content, errorMessage);
        return textResult(`[send_message failed] ${errorMessage}`);
      }
      const trimmed = assistantText.trim();
      return textResult(trimmed.length > 0 ? trimmed : (isClaude ? "[claude completed with no output]" : "[no reply]"));
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

/** Tools that modify files — excluded when codingMode is 'send-message'. */
export const FILE_WRITING_TOOLS = ["write", "edit"];

export interface CreateWorkspaceToolsOptions {
  workspacePath: string;
  settings?: AgentToolSettings;
  /** Register the `send_message` tool. Requires `runtime` + `parentAgentId`. */
  sendMessageEnabled?: boolean;
  /** "send-message" excludes write/edit (caller delegates code edits). */
  codingMode?: "send-message" | "direct" | "auto";
  fsImpl?: FsImpl;
  parentAgentId?: string;
  /** Caller's tool list — filtered + lent to leaf sessions. */
  parentTools?: AgentTool[];
  /** Unified runtime — required when sendMessageEnabled is true. */
  runtime?: AgentRuntime;
  /** Pre-computed list of registered agent ids the LLM can address. */
  spawnableAgentIds?: string[];
}

export function createWorkspaceToolsWithGuards(options: CreateWorkspaceToolsOptions): AgentTool[] {
  const {
    workspacePath,
    settings,
    sendMessageEnabled = false,
    codingMode = "auto",
    fsImpl = nodeFs,
    parentAgentId,
    parentTools,
    runtime,
    spawnableAgentIds,
  } = options;

  let tools: AgentTool[] = [
    ...createFsTools(workspacePath, fsImpl),
    createTimeTool(),
  ];
  if (sendMessageEnabled && runtime && parentAgentId) {
    tools.push(createSendMessageTool({
      runtime,
      parentAgentId,
      workspacePath,
      ...(parentTools ? { parentTools } : {}),
      ...(spawnableAgentIds ? { spawnableAgentIds } : {}),
    }));
  }
  if (settings?.web) {
    tools.push(createWebFetchTool());
    tools.push(createWebSearchTool());
  }
  if (codingMode === "send-message") {
    tools = tools.filter((t) => !FILE_WRITING_TOOLS.includes(t.name));
  }
  return tools;
}

// ---------------------------------------------------------------------------
// createAgentTools — unified entry point used by agent-init.
// Bundles workspace + react + exec into one factory so the caller doesn't
// have to assemble three separate clusters with three separate dep shapes.
// ---------------------------------------------------------------------------

export interface CreateAgentToolsOptions extends CreateWorkspaceToolsOptions {
  /** Discord/transport context for `message_react`. Omit to skip react tools. */
  transportContext?: LazyTransportContext;
  /** Background process registry for exec tools. */
  processRegistry: ProcessRegistry;
  /** Sandbox executor (omitted for non-sandboxed agents). */
  sandboxExecutor?: SandboxExecutor;
  /** Resolved sandbox config for this agent. */
  agentSandboxConfig?: SandboxConfig;
  /** Workspaces this agent may access via exec. */
  allowedWorkspaces?: string[];
  /** Agent id (used by exec for sandbox routing). */
  agentId: string;
}

export function createAgentTools(opts: CreateAgentToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  // Workspace tools first — send_message inside captures the `tools` array by
  // reference so its `leafContext.tools` sees the fully populated set when the
  // tool is later invoked (push mutates in place, the ref doesn't change).
  tools.push(...applyToolPolicy(
    createWorkspaceToolsWithGuards({ ...opts, parentTools: tools }),
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
