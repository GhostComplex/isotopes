// In-process runner. Two kinds: root (registered agent's cache+SOUL+store)
// and leaf (ephemeral cache + parent's filtered tools).

import { randomUUID } from "node:crypto";
import { createLogger } from "../../core/logger.js";
import { PiMonoCore } from "../../core/pi-mono.js";
import { ToolRegistry, type ToolHandler } from "../../core/tools.js";
import { buildSpawnAgentSystemPrompt } from "../builtin/system-prompt.js";
import type {
  AgentSessionKind,
  RegisteredAgent,
  SendMessageRequest,
} from "../types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const DENIED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "web_fetch",
  "web_search",
  "send_message",
]);

const log = createLogger("agents:runner:builtin");

const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

function isAgentEvent(e: { type: string }): e is AgentEvent {
  return AGENT_EVENT_TYPES.has(e.type);
}

export class BuiltinRunner {
  constructor(private readonly core: PiMonoCore) {}

  async *sendMessage(opts: {
    request: SendMessageRequest;
    agent?: RegisteredAgent;
    kind: AgentSessionKind;
    sessionId: string;
    runId: string;
    abort: AbortSignal;
    onSessionReady?: (session: AgentSession) => void;
  }): AsyncGenerator<AgentEvent> {
    const { request, agent, kind, sessionId, runId, abort, onSessionReady } = opts;

    let session: AgentSession;
    let cleanup: (() => void) | undefined;

    if (kind === "root") {
      if (!agent) throw new Error("BuiltinRunner.sendMessage: root requires agent");
      log.info("BuiltinRunner.sendMessage (root)", { runId, agentId: agent.id, sessionId });
      const sessionManager = await agent.sessionStore.getSessionManager(sessionId);
      if (!sessionManager) throw new Error(`Session "${sessionId}" not found`);
      session = await agent.cache.createSession({
        sessionManager,
        systemPrompt: agent.systemPrompt,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      });
    } else {
      const leaf = request.leafContext;
      if (!leaf) throw new Error("BuiltinRunner.sendMessage: leaf requires leafContext");
      const ephAgentId = `agent-builtin-${runId}-${randomUUID().slice(0, 8)}`;
      const filteredTools = filterTools(leaf.tools, ephAgentId);
      log.info("BuiltinRunner.sendMessage (leaf)", { runId, ephAgentId, toolCount: filteredTools.list().length });
      this.core.setToolRegistry(ephAgentId, filteredTools);
      const cache = this.core.createServiceCache({
        id: ephAgentId,
        provider: leaf.provider,
        compaction: { mode: "off" },
      });
      const sessionManager = SessionManager.inMemory();
      const systemPrompt = buildSpawnAgentSystemPrompt({
        task: request.content,
        ...(leaf.extraSystemPrompt ? { extraSystemPrompt: leaf.extraSystemPrompt } : {}),
      });
      session = await cache.createSession({ sessionManager, systemPrompt });
      cleanup = () => this.core.clearToolRegistry(ephAgentId);
    }

    onSessionReady?.(session);

    const onAbort = () => session.abort();
    abort.addEventListener("abort", onAbort, { once: true });
    if (abort.aborted) session.abort();

    try {
      yield* streamSessionAgentEvents(session, request.content);
    } finally {
      abort.removeEventListener("abort", onAbort);
      session.dispose();
      cleanup?.();
    }
  }
}

function filterTools(parent: ToolRegistry, agentId: string): ToolRegistry {
  const filtered = new ToolRegistry(agentId);
  for (const tool of parent.list()) {
    if (DENIED_TOOLS.has(tool.name)) continue;
    const entry = parent.get(tool.name);
    if (!entry) continue;
    filtered.register(tool, entry.handler as ToolHandler);
  }
  return filtered;
}

/** Drives `session.prompt(content)` and forwards SDK AgentEvents until
 * `agent_end`. */
async function* streamSessionAgentEvents(
  session: AgentSession,
  content: string,
): AsyncGenerator<AgentEvent, void, void> {
  type QueueItem = AgentEvent | { type: "__error__"; error: unknown };
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    if (!isAgentEvent(event)) return;
    queue.push(event as AgentEvent);
    if (resolve) { resolve(); resolve = null; }
  });

  session.prompt(content).catch((err) => {
    queue.push({ type: "__error__", error: err });
    if (resolve) { resolve(); resolve = null; }
  });

  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => { resolve = r; });
      }
      const item = queue.shift()!;
      if ((item as { type: string }).type === "__error__") {
        throw (item as { error: unknown }).error;
      }
      const e = item as AgentEvent;
      yield e;
      if (e.type === "agent_end") return;
    }
  } finally {
    unsub();
  }
}
