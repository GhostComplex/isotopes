// src/core/agent-runner.ts — Shared agent event loop using AgentSession

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { SessionStore } from "./types.js";
import type { AgentServiceCache } from "./pi-mono.js";
import { userMessage, assistantMessage, getAgentEndMeta, getUsage } from "./messages.js";
import type { Logger } from "./logger.js";
import type { UsageTracker } from "./usage-tracker.js";
import type { HookRegistry } from "../plugins/hooks.js";
import { isAgentEvent } from "./agent-events.js";

export interface AgentRunResult {
  responseText: string;
  errorMessage: string | null;
}

export type OnTextDelta = (currentText: string) => void | Promise<void>;
export type OnToolEvent = (event: { type: "start" | "end"; toolName: string; args?: unknown; result?: unknown; isError?: boolean }) => void;

export interface RunAgentOptions {
  cache: AgentServiceCache;
  sessionStore: SessionStore;
  sessionId: string;
  systemPrompt: string;
  cwd?: string;
  textInput?: string;
  log: Logger;
  onTextDelta?: OnTextDelta;
  onToolEvent?: OnToolEvent;
  usageTracker?: UsageTracker;
  onToolComplete?: () => Promise<string | null>;
  agentId?: string;
  hooks?: HookRegistry;
}


export async function runAgentLoop(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { cache, sessionStore, sessionId, systemPrompt, cwd, textInput, log, onTextDelta, onToolEvent, usageTracker, onToolComplete, agentId, hooks } = opts;

  if (hooks && agentId && textInput) {
    await hooks.emit("message_received", {
      agentId,
      sessionId,
      message: userMessage(textInput),
    });
  }

  const sessionManager = await sessionStore.getSessionManager(sessionId);
  if (!sessionManager) {
    throw new Error(`Session "${sessionId}" not found or has no SessionManager`);
  }

  const session = await cache.createSession({
    sessionManager,
    systemPrompt,
    cwd,
  });

  let responseText = "";
  let errorMessage: string | null = null;
  let activeSession: AgentSession | undefined = session;

  try {
    const result = await runSessionEvents(session, {
      textInput,
      log,
      onTextDelta,
      onToolEvent,
      usageTracker,
      sessionId,
      onToolComplete,
    });
    responseText = result.responseText;
    errorMessage = result.errorMessage;

    if (hooks && agentId && responseText) {
      await hooks.emit("message_sending", {
        agentId,
        sessionId,
        message: assistantMessage(responseText),
      });
    }

    if (hooks && agentId) {
      await hooks.emit("agent_end", { agentId, stopReason: errorMessage ? "error" : "end" });
    }
  } finally {
    activeSession?.dispose();
    activeSession = undefined;
  }

  return { responseText, errorMessage };
}

/** Returned handle for callers that need to steer/abort a running session */
export interface ActiveAgentHandle {
  session: AgentSession;
  done: Promise<AgentRunResult>;
  abort(): void;
}

/**
 * Start an agent loop and return a handle for mid-run control (steer, abort).
 * The session is NOT disposed automatically — caller must dispose.
 */
export async function startAgentLoop(opts: RunAgentOptions): Promise<ActiveAgentHandle> {
  const { cache, sessionStore, sessionId, systemPrompt, cwd, textInput, log, onTextDelta, onToolEvent, usageTracker, onToolComplete, agentId, hooks } = opts;

  if (hooks && agentId && textInput) {
    await hooks.emit("message_received", {
      agentId,
      sessionId,
      message: userMessage(textInput),
    });
  }

  const sessionManager = await sessionStore.getSessionManager(sessionId);
  if (!sessionManager) {
    throw new Error(`Session "${sessionId}" not found or has no SessionManager`);
  }

  const session = await cache.createSession({ sessionManager, systemPrompt, cwd });

  const done = runSessionEvents(session, {
    textInput,
    log,
    onTextDelta,
    onToolEvent,
    usageTracker,
    sessionId,
    onToolComplete,
  }).then(async (result) => {
    if (hooks && agentId && result.responseText) {
      await hooks.emit("message_sending", {
        agentId,
        sessionId,
        message: assistantMessage(result.responseText),
      });
    }
    if (hooks && agentId) {
      await hooks.emit("agent_end", { agentId, stopReason: result.errorMessage ? "error" : "end" });
    }
    return result;
  });

  return {
    session,
    done,
    abort: () => session.abort(),
  };
}

// ---------------------------------------------------------------------------
// Internal: drive a session and collect events
// ---------------------------------------------------------------------------

interface SessionRunOpts {
  textInput?: string;
  log: Logger;
  onTextDelta?: OnTextDelta;
  onToolEvent?: OnToolEvent;
  usageTracker?: UsageTracker;
  sessionId: string;
  onToolComplete?: () => Promise<string | null>;
}

async function runSessionEvents(
  session: AgentSession,
  opts: SessionRunOpts,
): Promise<AgentRunResult> {
  const { textInput, log, onTextDelta, onToolEvent, usageTracker, sessionId, onToolComplete } = opts;

  let responseText = "";
  let errorMessage: string | null = null;

  return new Promise<AgentRunResult>((resolve, reject) => {
    const unsub = session.subscribe(async (event: AgentSessionEvent) => {
      if (!isAgentEvent(event)) return;
      const e = event as AgentEvent;

      if (e.type === "message_update") {
        const ame = e.assistantMessageEvent;
        if (ame.type === "text_delta") {
          responseText += ame.delta;
          if (onTextDelta) {
            void onTextDelta(responseText);
          }
        }
      } else if (e.type === "tool_execution_start") {
        log.debug(`Tool call: ${e.toolName}`, { id: e.toolCallId });
        onToolEvent?.({ type: "start", toolName: e.toolName, args: e.args });
      } else if (e.type === "tool_execution_end") {
        log.debug(`Tool result: ${e.toolCallId}`);
        onToolEvent?.({ type: "end", toolName: e.toolName, result: e.result, isError: e.isError });
      } else if (e.type === "turn_end") {
        const usage = getUsage(e.message);
        if (usageTracker && usage) {
          usageTracker.record(sessionId, usage as Parameters<typeof usageTracker.record>[1]);
        }

        if (onToolComplete) {
          try {
            const pendingContext = await onToolComplete();
            if (pendingContext) {
              log.debug("Injecting pending messages via steer()");
              await session.steer(pendingContext);
            }
          } catch (err) {
            log.warn("onToolComplete failed", { error: err });
          }
        }
      } else if (e.type === "agent_end") {
        const { stopReason, errorMessage: errMsg } = getAgentEndMeta(e.messages);
        if (stopReason === "error") {
          const msg = errMsg ?? "Unknown agent error";
          log.error(`Agent ended with error: ${msg}`);
          errorMessage = msg;
        }

        unsub();
        resolve({ responseText, errorMessage });
      }
    });

    // Start the prompt
    session.prompt(textInput ?? "").catch((err) => {
      unsub();
      reject(err);
    });
  });
}
