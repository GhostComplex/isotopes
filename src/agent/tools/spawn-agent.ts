import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { AgentRuntime } from "../runtime.js";
import { RunValidationError } from "../types.js";
import type { RunRequest } from "../types.js";
import { getRuntimeContext } from "../runtime-context.js";
import { getDiscordA2AStreamContext } from "../../legacy/plugins/discord/a2a-stream-context.js";
import { DiscordA2ASink } from "../../legacy/plugins/discord/discord-a2a-sink.js";
import { getAgentEndMeta } from "../runners/pi/messages.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("tools");

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

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
      const ctx = getRuntimeContext();

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
