// Decorator over runtime.run for chat-style consumers. Use runtime.run
// directly for raw event streams.

import type { AgentRuntime } from "./runtime.js";
import { userMessage, assistantMessage, getAgentEndMeta } from "./runners/pi/messages.js";
import type { Logger } from "../logging/logger.js";
import type { HookRegistry } from "../legacy/plugins/hooks.js";
import { runWithMessageContext } from "../legacy/transport/context.js";

export interface RunAgentOptions {
  to: string;
  sessionId: string;
  content: string;
  cwd?: string;
  log: Logger;
  hooks?: HookRegistry;
  /** Fires at every turn boundary; non-null return is steered into the next turn. */
  onTurnEnd?: () => Promise<string | null>;
}

export interface RunAgentResult {
  responseText: string;
  errorMessage: string | null;
}

export async function runAgent(
  runtime: AgentRuntime,
  opts: RunAgentOptions,
): Promise<RunAgentResult> {
  const { to, sessionId, content, cwd, log, hooks, onTurnEnd } = opts;

  if (hooks && content) {
    await hooks.emit("message_received", {
      agentId: to,
      sessionId,
      message: userMessage(content),
    });
  }

  let responseText = "";
  let errorMessage: string | null = null;

  try {
    const stream = runtime.run({
      to,
      sessionId,
      content,
      ...(cwd ? { cwd } : {}),
    });

    await runWithMessageContext(
      { transport: "internal", channelKey: sessionId, agentId: to, parentSessionId: sessionId },
      async () => {
        for await (const event of stream) {
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") responseText += ame.delta;
          } else if (event.type === "turn_end") {
            if (onTurnEnd) {
              try {
                const pending = await onTurnEnd();
                if (pending) {
                  log.debug("Injecting pending messages via runtime.steer()");
                  await runtime.steer(sessionId, pending);
                }
              } catch (err) {
                log.warn("onTurnEnd failed", { error: err });
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
    log.error(`runtime.run threw: ${errorMessage}`);
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
