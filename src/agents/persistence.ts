import { randomUUID } from "node:crypto";

import { createLogger } from "../core/logger.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  Session,
  SessionMetadata,
  SessionStore,
  SubagentSessionMetadata,
} from "../core/types.js";
import type { RunEvent } from "./types.js";

const log = createLogger("agents:persistence");

export function buildRunSessionKey(targetAgentId: string): string {
  return `agent:${targetAgentId}:run:${randomUUID()}`;
}

const MAX_INLINE_LEN = 4_000;

function truncate(value: string, max = MAX_INLINE_LEN): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function runEventToMessage(event: RunEvent): AgentMessage | undefined {
  const timestamp = Date.now();
  switch (event.type) {
    case "run:start":
    case "run:done":
      return undefined;

    case "run:message":
      return {
        role: "assistant",
        content: [{ type: "text", text: event.content }],
        timestamp,
      } as unknown as AgentMessage;

    case "run:tool_use": {
      const input = event.toolInput === undefined ? "" : truncate(safeStringify(event.toolInput));
      const text = input ? `🔧 ${event.toolName}(${input})` : `🔧 ${event.toolName}()`;
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp,
      } as unknown as AgentMessage;
    }

    case "run:tool_result":
      return {
        role: "toolResult",
        content: truncate(event.toolResult),
        toolCallId: "run",
        toolName: event.toolName,
        timestamp,
      } as unknown as AgentMessage;

    case "run:error":
      return {
        role: "assistant",
        content: [{ type: "text", text: `❌ ${event.error}` }],
        timestamp,
      } as unknown as AgentMessage;

    default:
      return undefined;
  }
}

export function terminalEventPatch(event: RunEvent): Partial<SubagentSessionMetadata> | undefined {
  switch (event.type) {
    case "run:done":
      return { exitCode: event.exitCode, costUsd: event.costUsd };
    case "run:error":
      return { error: event.error };
    default:
      return undefined;
  }
}

export interface RunRecorder {
  record(event: RunEvent): Promise<void>;
  patchMetadata(patch: Partial<SubagentSessionMetadata>): Promise<void>;
  sessionId?: string;
}

const NOOP_RECORDER: RunRecorder = {
  async record() {},
  async patchMetadata() {},
};

export interface CreateRecorderOptions {
  store?: SessionStore;
  targetAgentId: string;
  sessionKey?: string;
  parentAgentId: string;
  parentSessionId?: string;
  taskId: string;
  backend: string;
  cwd?: string;
  prompt?: string;
  channelId?: string;
  threadId?: string;
}

export async function createRunRecorder(
  options: CreateRecorderOptions,
): Promise<RunRecorder> {
  const { store } = options;
  if (!store) return NOOP_RECORDER;

  const subagentMeta: SubagentSessionMetadata = {
    parentAgentId: options.parentAgentId,
    parentSessionId: options.parentSessionId,
    taskId: options.taskId,
    backend: options.backend,
    cwd: options.cwd,
    prompt: options.prompt,
  };
  const metadata: SessionMetadata = {
    key: options.sessionKey ?? buildRunSessionKey(options.targetAgentId),
    subagent: subagentMeta,
    channelId: options.channelId,
    threadId: options.threadId,
  };

  let session: Session;
  try {
    session = await store.create(options.targetAgentId, metadata);
  } catch (err) {
    log.warn("Failed to create run session, persistence disabled for this run", {
      taskId: options.taskId,
      targetAgentId: options.targetAgentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOOP_RECORDER;
  }

  const sessionId = session.id;
  const startedAt = Date.now();

  return {
    sessionId,
    async record(event) {
      const message = runEventToMessage(event);
      if (!message) return;
      try {
        await store.addMessage(sessionId, message);
      } catch (err) {
        log.warn("Failed to persist run event", {
          sessionId,
          taskId: options.taskId,
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async patchMetadata(patch) {
      try {
        const current = await store.get(sessionId);
        const prev = current?.metadata?.subagent ?? subagentMeta;
        const durationMs =
          patch.durationMs === undefined && (patch.exitCode !== undefined || patch.error !== undefined)
            ? Date.now() - startedAt
            : patch.durationMs;
        const merged: SubagentSessionMetadata = {
          ...prev,
          ...patch,
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        await store.setMetadata(sessionId, { subagent: merged });
      } catch (err) {
        log.warn("Failed to patch run metadata", {
          sessionId,
          taskId: options.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
