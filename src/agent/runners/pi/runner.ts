import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

import { createLogger } from "../../../logging/logger.js";
import type { ProviderConfig } from "../../types.js";
import type { Tool } from "../../../tools/types.js";
import type { ToolHandler } from "../../../legacy/core/tools.js";
import type { HookRegistry } from "../../../legacy/plugins/hooks.js";
import { buildSpawnAgentSystemPrompt } from "../../../legacy/agents/builtin/system-prompt.js";
import type {
  AgentSessionKind,
  RegisteredAgent,
  SendMessageRequest,
} from "../../../legacy/agents/types.js";
import { createPiAgentSession } from "./session-factory.js";

const DENIED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "web_fetch",
  "web_search",
  "send_message",
]);

const log = createLogger("agents:runner:pi");

const AGENT_EVENT_TYPES = new Set([
  "agent_start", "agent_end",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

function isAgentEvent(e: { type: string }): e is AgentEvent {
  return AGENT_EVENT_TYPES.has(e.type);
}

export interface PiRunnerDeps {
  globalProvider: ProviderConfig;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** Per-agent tool entries — runtime owns the per-agent tools map. */
  getAgentTools: (agentId: string) => Array<{ tool: Tool; handler: ToolHandler }>;
  hooks?: HookRegistry;
}

export class PiRunner {
  constructor(private readonly deps: PiRunnerDeps) {}

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

    if (kind === "root") {
      if (!agent) throw new Error("PiRunner.sendMessage: root requires agent");
      log.info("PiRunner.sendMessage (root)", { runId, agentId: agent.id, sessionId });
      const sessionManager = await agent.sessionStore.getSessionManager(sessionId);
      if (!sessionManager) throw new Error(`Session "${sessionId}" not found`);
      session = await createPiAgentSession({
        globalProvider: this.deps.globalProvider,
        authStorage: this.deps.authStorage,
        modelRegistry: this.deps.modelRegistry,
        agentConfig: agent.config,
        tools: this.deps.getAgentTools(agent.id),
        sessionManager,
        systemPrompt: agent.systemPrompt,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(this.deps.hooks ? { hooks: this.deps.hooks } : {}),
      });
    } else {
      const leaf = request.leafContext;
      if (!leaf) throw new Error("PiRunner.sendMessage: leaf requires leafContext");
      const ephAgentId = `agent-builtin-${runId}-${randomUUID().slice(0, 8)}`;
      const filteredTools = filterToolEntries(leaf.tools);
      log.info("PiRunner.sendMessage (leaf)", { runId, ephAgentId, toolCount: filteredTools.length });
      const sessionManager = SessionManager.inMemory();
      const systemPrompt = buildSpawnAgentSystemPrompt({
        task: request.content,
        ...(leaf.extraSystemPrompt ? { extraSystemPrompt: leaf.extraSystemPrompt } : {}),
      });
      session = await createPiAgentSession({
        globalProvider: this.deps.globalProvider,
        authStorage: this.deps.authStorage,
        modelRegistry: this.deps.modelRegistry,
        agentConfig: { id: ephAgentId, compaction: { mode: "off" } },
        tools: filteredTools,
        sessionManager,
        systemPrompt,
        ...(this.deps.hooks ? { hooks: this.deps.hooks } : {}),
      });
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
    }
  }
}

function filterToolEntries(
  parent: Array<{ tool: Tool; handler: ToolHandler }>,
): Array<{ tool: Tool; handler: ToolHandler }> {
  return parent.filter((entry) => !DENIED_TOOLS.has(entry.tool.name));
}

/** Drives `session.prompt(content)` and forwards SDK AgentEvents until `agent_end`. */
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
