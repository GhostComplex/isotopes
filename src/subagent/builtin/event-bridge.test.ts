// src/subagent/builtin/event-bridge.test.ts — Tests for AgentEvent → SubagentEvent bridge

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { SubagentEvent } from "../types.js";
import { bridgeAgentEvents } from "./event-bridge.js";

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, void> {
  for (const item of items) yield item;
}

async function collect(events: AgentEvent[]): Promise<SubagentEvent[]> {
  const out: SubagentEvent[] = [];
  for await (const e of bridgeAgentEvents(fromArray(events))) out.push(e);
  return out;
}

describe("bridgeAgentEvents", () => {
  it("buffers text_delta and emits a single message at turn_end", async () => {
    const out = await collect([
      { type: "turn_start" },
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "Hello, " } as never },
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "world." } as never },
      { type: "turn_end", message: {} as never, toolResults: [] },
      { type: "agent_end", messages: [] },
    ]);
    expect(out).toEqual([
      { type: "message", content: "Hello, world." },
      { type: "done", exitCode: 0 },
    ]);
  });

  it("skips empty messages", async () => {
    const out = await collect([
      { type: "turn_start" },
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "   " } as never },
      { type: "turn_end", message: {} as never, toolResults: [] },
      { type: "agent_end", messages: [] },
    ]);
    expect(out).toEqual([{ type: "done", exitCode: 0 }]);
  });

  it("translates tool_call → tool_use", async () => {
    const out = await collect([
      { type: "tool_execution_start", toolCallId: "1", toolName: "shell", args: { cmd: "ls" } },
      { type: "agent_end", messages: [] },
    ]);
    expect(out[0]).toEqual({ type: "tool_use", toolName: "shell", toolInput: { cmd: "ls" } });
  });

  it("translates tool_result and surfaces error flag", async () => {
    const out = await collect([
      { type: "tool_execution_end", toolCallId: "1", toolName: "test", result: "ok", isError: false },
      { type: "tool_execution_end", toolCallId: "2", toolName: "test", result: "boom", isError: true },
      { type: "agent_end", messages: [] },
    ]);
    expect(out[0]).toEqual({ type: "tool_result", toolResult: "ok" });
    expect(out[1]).toEqual({ type: "tool_result", toolResult: "boom", error: "tool error" });
  });

  it("emits error+done(1) when agent_end carries errorMessage", async () => {
    const out = await collect([
      { type: "agent_end", messages: [{ role: "assistant", errorMessage: "boom", content: [], timestamp: Date.now() } as never] },
    ]);
    expect(out).toEqual([
      { type: "error", error: "boom" },
      { type: "done", exitCode: 1 },
    ]);
  });

  it("emits error+done(1) when agent_end has errorMessage", async () => {
    const out = await collect([
      { type: "agent_end", messages: [{ role: "assistant", errorMessage: "kaboom", content: [], timestamp: 0 } as never] },
    ]);
    expect(out).toEqual([
      { type: "error", error: "kaboom" },
      { type: "done", exitCode: 1 },
    ]);
  });

  it("flushes trailing text and emits done if stream ends without agent_end", async () => {
    const out = await collect([
      { type: "turn_start" },
      { type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "tail" } as never },
    ]);
    expect(out).toEqual([
      { type: "message", content: "tail" },
      { type: "done", exitCode: 0 },
    ]);
  });
});
