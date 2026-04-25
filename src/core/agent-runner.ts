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
import { agentEventBus } from "./agent-event-bus.js";

// ---------------------------------------------------------------------------
// Active session registry — allows external abort/steer by sessionId
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, AgentSession>();

export function abortAgentSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.abort();
  return true;
}

export function steerAgentSession(sessionId: string, text: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  void session.steer(text);
  return true;
}

export function isAgentSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  responseText: string;
  errorMessage: string | null;
}

export interface RunAgentOptions {
  cache: AgentServiceCache;
  sessionStore: SessionStore;
  sessionId: string;
  systemPrompt: string;
  cwd?: string;
  textInput?: string;
  log: Logger;
  usageTracker?: UsageTracker;
  onToolComplete?: () => Promise<string | null>;
  agentId?: string;
  hooks?: HookRegistry;
}

export async function runAgentLoop(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { cache, sessionStore, sessionId, systemPrompt, cwd, textInput, log, usageTracker, onToolComplete, agentId, hooks } = opts;

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

  activeSessions.set(sessionId, session);

  try {
    const result = await runSessionEvents(session, {
      textInput,
      log,
      usageTracker,
      sessionId,
      onToolComplete,
    });

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
  } finally {
    activeSessions.delete(sessionId);
    session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Internal: drive a session and collect events
// ---------------------------------------------------------------------------

interface SessionRunOpts {
  textInput?: string;
  log: Logger;
  usageTracker?: UsageTracker;
  sessionId: string;
  onToolComplete?: () => Promise<string | null>;
}

async function runSessionEvents(
  session: AgentSession,
  opts: SessionRunOpts,
): Promise<AgentRunResult> {
  const { textInput, log, usageTracker, sessionId, onToolComplete } = opts;

  let responseText = "";
  let errorMessage: string | null = null;

  return new Promise<AgentRunResult>((resolve, reject) => {
    const unsub = session.subscribe(async (event: AgentSessionEvent) => {
      if (!isAgentEvent(event)) return;
      const e = event as AgentEvent;
      agentEventBus.session(sessionId).emit(e);

      if (e.type === "message_update") {
        const ame = e.assistantMessageEvent;
        if (ame.type === "text_delta") {
          responseText += ame.delta;
        }
      } else if (e.type === "tool_execution_start") {
        log.debug(`Tool call: ${e.toolName}`, { id: e.toolCallId });
      } else if (e.type === "tool_execution_end") {
        log.debug(`Tool result: ${e.toolCallId}`);
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
