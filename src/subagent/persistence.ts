// src/subagent/persistence.ts — Subagent run persistence helpers.
//
// Bridges the subagent event stream into the shared SessionStore so that
// each run is recorded as a session under the **target agent's** sessions
// directory (real agentId, not a synthetic one). The "this is a subagent
// run" signal lives in `sessionKey` (`agent:<targetId>:subagent:<uuid>`)
// and in `metadata.subagent`. See docs/subagent-architecture.md §4.4.

import { randomUUID } from "node:crypto";

import { createLogger } from "../core/logger.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  Session,
  SessionMetadata,
  SessionStore,
  SubagentSessionMetadata,
} from "../core/types.js";
import type { SubagentEvent } from "./types.js";

const log = createLogger("subagent:persistence");

/** Build the default sessionKey for a subagent run. */
export function buildSubagentSessionKey(targetAgentId: string): string {
  return `agent:${targetAgentId}:subagent:${randomUUID()}`;
}

/** Maximum length of inlined tool input/output before truncation. */
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

/**
 * Convert one SubagentEvent into an AgentMessage suitable for SessionStore.
 *
 * Returns undefined for control events (start/done) — those drive
 * session lifecycle and metadata, not transcript content.
 *
 * Tool calls are encoded as plain text for now (see issue #400 scope:
 * structured tool_use blocks deferred). Tool results use the existing
 * `tool_result` content block so downstream consumers can read them
 * uniformly with main-agent transcripts.
 */
export function eventToMessage(event: SubagentEvent): AgentMessage | undefined {
  const timestamp = Date.now();
  switch (event.type) {
    case "start":
    case "done":
      return undefined;

    case "message": {
      const text = event.content;
      if (!text) return undefined;
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp,
      } as unknown as AgentMessage;
    }

    case "tool_use": {
      const name = event.toolName ?? "tool";
      const input = event.toolInput === undefined ? "" : truncate(safeStringify(event.toolInput));
      const text = input ? `🔧 ${name}(${input})` : `🔧 ${name}()`;
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp,
      } as unknown as AgentMessage;
    }

    case "tool_result": {
      const output = truncate(event.toolResult ?? "");
      return {
        role: "toolResult",
        content: output,
        toolCallId: "subagent",
        toolName: event.toolName ?? "unknown",
        timestamp,
      } as unknown as AgentMessage;
    }

    case "error": {
      const text = event.error ?? "Unknown error";
      return {
        role: "assistant",
        content: [{ type: "text", text: `❌ ${text}` }],
        timestamp,
      } as unknown as AgentMessage;
    }

    default:
      return undefined;
  }
}

/**
 * Extract a metadata patch from a terminal event (`done` / `error`).
 * Returns undefined for non-terminal events.
 */
export function terminalEventPatch(event: SubagentEvent): Partial<SubagentSessionMetadata> | undefined {
  if (event.type === "done") {
    return {
      exitCode: event.exitCode,
      costUsd: event.costUsd,
    };
  }
  if (event.type === "error") {
    return {
      error: event.error,
    };
  }
  return undefined;
}

/**
 * Bind a subagent run to a SessionStore. Returns helpers for the spawn
 * loop to record events without leaking persistence concerns.
 *
 * If `store` is undefined (no persistence configured), every method
 * becomes a no-op so callers don't need a null check.
 */
export interface SubagentRunRecorder {
  /** Append one event to the run's transcript (no-op for control events). */
  record(event: SubagentEvent): Promise<void>;
  /** Merge fields into the run's session metadata.subagent. */
  patchMetadata(patch: Partial<SubagentSessionMetadata>): Promise<void>;
  /** sessionId of the underlying transcript, or undefined if disabled. */
  sessionId?: string;
}

const NOOP_RECORDER: SubagentRunRecorder = {
  async record() {},
  async patchMetadata() {},
};

export interface CreateRecorderOptions {
  /**
   * Pre-resolved SessionStore for `targetAgentId`. Caller is responsible for
   * obtaining this from the SessionStoreManager. Pass undefined to disable
   * persistence for this run.
   */
  store?: SessionStore;
  /**
   * Real agentId the run is recorded against. For named subagents this is
   * the subagent's own id (e.g. `code-reviewer`); for anonymous/dynamic
   * subagents the caller falls back to the parent agentId.
   */
  targetAgentId: string;
  /**
   * sessionKey to assign to the persisted session. Defaults to
   * `agent:<targetAgentId>:subagent:<uuid>`.
   */
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

export async function createSubagentRecorder(
  options: CreateRecorderOptions,
): Promise<SubagentRunRecorder> {
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
    key: options.sessionKey ?? buildSubagentSessionKey(options.targetAgentId),
    subagent: subagentMeta,
    channelId: options.channelId,
    threadId: options.threadId,
  };

  let session: Session;
  try {
    session = await store.create(options.targetAgentId, metadata);
  } catch (err) {
    log.warn("Failed to create subagent session, persistence disabled for this run", {
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
      const message = eventToMessage(event);
      if (!message) return;
      try {
        await store.addMessage(sessionId, message);
      } catch (err) {
        log.warn("Failed to persist subagent event", {
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
        log.warn("Failed to patch subagent metadata", {
          sessionId,
          taskId: options.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
