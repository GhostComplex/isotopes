// Adapter: AgentEvent stream → {responseText, errorMessage} for chat
// callers (REST/Discord/heartbeat/cron). Also wires hooks, usage tracker,
// agentEventBus emission, and mid-turn steer-from-pending-buffer.

import type { AgentRuntime } from "../agents/runtime.js";
import { agentEventBus } from "./agent-event-bus.js";
import { userMessage, assistantMessage, getAgentEndMeta, getUsage } from "./messages.js";
import type { Logger } from "./logger.js";
import type { UsageTracker } from "./usage-tracker.js";
import type { HookRegistry } from "../plugins/hooks.js";
import { runWithMessageContext } from "../transport/context.js";

export interface ConsumeRootRunOptions {
  /** Registered agent id to address. */
  to: string;
  /** Explicit session id (chat callers always have one already). */
  sessionId: string;
  /** User message content for this turn. */
  content: string;
  cwd?: string;
  log: Logger;
  hooks?: HookRegistry;
  usageTracker?: UsageTracker;
  /**
   * Called at the end of every turn. Returning a non-null string causes
   * `runtime.steer(runId, msg)` to inject it before the next turn — used
   * by transports that buffer mid-run user messages.
   */
  onToolComplete?: () => Promise<string | null>;
}

export interface ConsumeRootRunResult {
  responseText: string;
  errorMessage: string | null;
}

export async function consumeRootRun(
  runtime: AgentRuntime,
  opts: ConsumeRootRunOptions,
): Promise<ConsumeRootRunResult> {
  const { to, sessionId, content, cwd, log, hooks, usageTracker, onToolComplete } = opts;

  if (hooks && content) {
    await hooks.emit("message_received", {
      agentId: to,
      sessionId,
      message: userMessage(content),
    });
  }

  let responseText = "";
  let errorMessage: string | null = null;
  let runId: string | undefined;

  try {
    const stream = runtime.sendMessage({
      to,
      sessionId,
      content,
      ...(cwd ? { cwd } : {}),
      onRunStart: (id) => { runId = id; },
    });

    // Wrap the iteration so the agent's tools (notably send_message) see
    // this session's id as `parentSessionId` via AsyncLocalStorage.
    await runWithMessageContext(
      { transport: "internal", channelKey: sessionId, agentId: to, parentSessionId: sessionId },
      async () => {
        for await (const event of stream) {
          agentEventBus.session(sessionId).emit(event);

          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") responseText += ame.delta;
          } else if (event.type === "tool_execution_start") {
            log.debug(`Tool call: ${event.toolName}`, { id: event.toolCallId });
          } else if (event.type === "tool_execution_end") {
            log.debug(`Tool result: ${event.toolCallId}`);
          } else if (event.type === "turn_end") {
            const usage = getUsage(event.message);
            if (usageTracker && usage) {
              usageTracker.record(sessionId, usage as Parameters<typeof usageTracker.record>[1]);
            }
            if (onToolComplete && runId) {
              try {
                const pendingContext = await onToolComplete();
                if (pendingContext) {
                  log.debug("Injecting pending messages via runtime.steer()");
                  await runtime.steer(runId, pendingContext);
                }
              } catch (err) {
                log.warn("onToolComplete failed", { error: err });
              }
            }
          } else if (event.type === "agent_end") {
            const meta = getAgentEndMeta(event.messages);
            if (meta.stopReason === "error") {
              errorMessage = meta.errorMessage ?? "Unknown agent error";
              log.error(`Agent ended with error: ${errorMessage}`);
            }
          }
        }
      },
    );
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`runtime.sendMessage threw: ${errorMessage}`);
  }

  if (hooks && responseText) {
    await hooks.emit("message_sending", {
      agentId: to,
      sessionId,
      message: assistantMessage(responseText),
    });
  }
  if (hooks) {
    await hooks.emit("agent_end", { agentId: to, stopReason: errorMessage ? "error" : "end" });
  }

  return { responseText, errorMessage };
}

/** Cancel an active root run by sessionId. Default reason "user" so the
 * tool-result string can discourage retry. */
export function cancelRunBySessionId(runtime: AgentRuntime, sessionId: string, reason: string = "user"): boolean {
  const run = runtime.listRuns().find((r) => r.sessionId === sessionId);
  if (!run) return false;
  return runtime.cancel(run.runId, { reason });
}

/** Convenience: is there an in-flight root run for this sessionId? */
export function isRootRunActive(runtime: AgentRuntime, sessionId: string): boolean {
  return runtime.listRuns().some((r) => r.sessionId === sessionId);
}
