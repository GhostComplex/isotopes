import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { AgentRuntime } from "../runtime.js";
import { RunValidationError } from "../types.js";
import type { RunRequest } from "../types.js";
import { type A2ASink, getA2ASinkFactory } from "../a2a-sink.js";
import { getAgentEndMeta } from "../pi/messages.js";

export type A2ASurfaceInfo =
  | { status: "ok"; surfaceId: string }
  | { status: "error"; error: string }
  | { status: "silent" };

export interface SpawnAgentDetails {
  surface: A2ASurfaceInfo;
}

function textResult(text: string, surface: A2ASurfaceInfo): AgentToolResult<SpawnAgentDetails> {
  return { content: [{ type: "text", text }], details: { surface } };
}

export interface SpawnAgentToolOptions {
  runtime: AgentRuntime;
  parentAgentId: string;
  parentSessionId: string;
  workspacePath: string;
  allowedAgents?: string[];
  spawnableAgentIds?: readonly string[];
}

export function createSpawnAgentTool(options: SpawnAgentToolOptions): AgentTool {
  const { runtime, parentAgentId, parentSessionId, workspacePath, allowedAgents, spawnableAgentIds } = options;
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
    threadName: Type.Optional(Type.String({
      description:
        "Optional human-readable name for the Discord thread (or other channel surface) " +
        "that streams this sub-run. If omitted, a label is auto-derived from `to` and `content`.",
    })),
  });

  type Params = {
    to: string;
    content: string;
    working_directory?: string;
    threadName?: string;
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
      const { to, content, working_directory, threadName } = params;
      let surface: A2ASurfaceInfo = { status: "silent" };
      if (!targets.includes(to)) {
        return textResult(`[error] Unknown target: ${to}. Available: ${targets.join(", ")}`, surface);
      }
      const isRunner = runtime.hasRunner(to);
      const cwd = working_directory
        ? path.resolve(workspacePath, working_directory)
        : workspacePath;

      let cancelReason: string | undefined;
      const req: RunRequest = {
        to,
        content,
        cwd,
        from: { agentId: parentAgentId },
        parentSessionId,
        onCancel: (reason) => { cancelReason = reason; },
      };

      const sinkFactory = getA2ASinkFactory();
      let sink: A2ASink | undefined;
      const startedAt = Date.now();
      const taskLabel = `${to}: ${content.slice(0, 80)}${content.length > 80 ? "…" : ""}`;
      const label = threadName ?? taskLabel;

      let sinkStartPromise: Promise<void> | undefined;
      req.onRunStart = (sessionId: string) => {
        if (sinkFactory) {
          sink = sinkFactory();
          sinkStartPromise = sink.start({ sessionId, label }).then((res) => {
            surface = res.status === "ok"
              ? { status: "ok", surfaceId: res.surfaceId }
              : { status: "error", error: res.error };
          });
        }
      };

      let assistantText = "";
      let errorMessage: string | null = null;
      try {
        for await (const event of runtime.run(req)) {
          if (sinkStartPromise) { await sinkStartPromise; sinkStartPromise = undefined; }
          if (sink) await sink.send(event);
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
        if (sinkStartPromise) { await sinkStartPromise; sinkStartPromise = undefined; }
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof RunValidationError) {
          if (sink) await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
          return textResult(`[error] ${msg}`, surface);
        }
        if (sink) await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
        return textResult(`[spawn_agent failed] ${msg}`, surface);
      }

      if (sinkStartPromise) { await sinkStartPromise; sinkStartPromise = undefined; }

      if (cancelReason === "user") {
        if (sink) await sink.finish({ success: false, error: "cancelled by user", durationMs: Date.now() - startedAt });
        return textResult(`[spawn_agent cancelled by user — do not retry this same request]`, surface);
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
        return textResult(`[spawn_agent failed] ${errorMessage}`, surface);
      }
      const trimmed = assistantText.trim();
      return textResult(
        trimmed.length > 0 ? trimmed : (isRunner ? `[${to} completed with no output]` : "[no reply]"),
        surface,
      );
    },
  };
}
