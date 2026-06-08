import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import type { RunRequest } from "../../types.js";
import { RunValidationError } from "../../types.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createLogger } from "../../../logging/logger.js";

const log = createLogger("copilot-runner");

export class CopilotRunner {
  resolveSessionId(req: RunRequest): string {
    return req.sessionId ?? `copilot:${randomUUID()}`;
  }

  validateRequest(req: RunRequest): void {
    if (!req.cwd) throw new RunValidationError("copilot: cwd is required");
    if (req.sessionId) throw new RunValidationError("copilot: sessions are not resumable; omit sessionId");
  }

  async *run(opts: {
    request: RunRequest;
    sessionId: string;
    abort: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const { request, abort } = opts;

    const client = new CopilotClient({
      mode: "copilot-cli",
      workingDirectory: request.cwd,
      useLoggedInUser: true,
    });

    const queue = new EventQueue<Translated>();
    let assistantText = "";
    let costUsd: number | undefined;
    let errorMessage: string | undefined;
    let stopReason: string = "end";

    try {
      await client.start();

      const session = await client.createSession({
        onPermissionRequest: approveAll,
      });

      const onAbort = async () => {
        try { await session.abort(); } catch { /* ignore */ }
        queue.end();
      };
      abort.addEventListener("abort", onAbort, { once: true });
      if (abort.aborted) {
        await onAbort();
        return;
      }

      session.on("assistant.message_delta", (event) => {
        queue.push({ kind: "text", text: event.data.deltaContent });
      });

      session.on("tool.execution_start", (event) => {
        queue.push({
          kind: "tool_call",
          id: event.data.toolCallId,
          name: event.data.toolName,
          input: event.data.arguments,
        });
      });

      session.on("tool.execution_complete", (event) => {
        queue.push({
          kind: "tool_result",
          id: event.data.toolCallId,
          name: toolNameFromComplete(event),
          result: event.data.result,
          isError: !event.data.success,
        });
      });

      session.on("assistant.usage", (event) => {
        if (event.data.cost !== undefined) {
          costUsd = (costUsd ?? 0) + event.data.cost;
        }
      });

      session.on("session.idle", () => {
        queue.end();
      });

      await session.send({ prompt: request.content });

      for await (const ev of queue) {
        if (ev.kind === "text") {
          assistantText += ev.text;
          yield buildMessageUpdate(ev.text);
        } else if (ev.kind === "tool_call") {
          yield buildToolStart(ev.id, ev.name, ev.input);
        } else if (ev.kind === "tool_result") {
          yield buildToolEnd(ev.id, ev.name, ev.result, ev.isError);
        }
      }

      abort.removeEventListener("abort", onAbort);
      await session.disconnect();
    } catch (err) {
      stopReason = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      log.warn("Copilot run failed", { error: errorMessage });
    } finally {
      try { await client.stop(); } catch { /* ignore */ }
    }

    yield buildAgentEnd(assistantText, stopReason, errorMessage, costUsd);
  }
}

function toolNameFromComplete(event: { data: { toolCallId: string }; type: string }): string {
  return (event as unknown as { data: { toolName?: string } }).data.toolName ?? event.data.toolCallId;
}

type Translated =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; name: string; result: unknown; isError: boolean };

class EventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private finished = false;
  private rejected: Error | undefined;

  push(item: T): void {
    if (this.finished) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end(): void {
    this.finished = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  error(err: Error): void {
    this.rejected = err;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.rejected) return Promise.reject(this.rejected);
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift()!, done: false });
    }
    if (this.finished) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

function buildAssistantMessage(text: string, extras: { stopReason?: string; errorMessage?: string } = {}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: extras.stopReason ?? "end",
    ...(extras.errorMessage ? { errorMessage: extras.errorMessage } : {}),
  } as unknown as AgentMessage;
}

function buildMessageUpdate(delta: string): AgentEvent {
  const partial = buildAssistantMessage(delta) as unknown as AssistantMessage;
  const ame: AssistantMessageEvent = {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial,
  } as AssistantMessageEvent;
  return {
    type: "message_update",
    message: partial as unknown as AgentMessage,
    assistantMessageEvent: ame,
  };
}

function buildToolStart(toolCallId: string, toolName: string, args: unknown): AgentEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function buildToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): AgentEvent {
  return { type: "tool_execution_end", toolCallId, toolName, result, isError };
}

function buildAgentEnd(text: string, stopReason: string, errorMessage: string | undefined, _costUsd: number | undefined): AgentEvent {
  return {
    type: "agent_end",
    messages: [buildAssistantMessage(text, { stopReason, ...(errorMessage ? { errorMessage } : {}) })],
  };
}
