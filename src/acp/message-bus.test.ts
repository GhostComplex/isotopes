// src/acp/message-bus.test.ts — Unit tests for AgentMessageBus

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentMessageBus } from "./message-bus.js";
import type { AgentMessage } from "./message-bus.js";
import { AcpSessionManager } from "./session-manager.js";
import type { AcpConfig } from "./types.js";

function makeConfig(overrides?: Partial<AcpConfig>): AcpConfig {
  return {
    enabled: true,
    defaultAgent: "claude",
    allowedAgents: ["claude", "codex", "agent-a", "agent-b", "agent-c"],
    ...overrides,
  };
}

describe("AgentMessageBus", () => {
  let bus: AgentMessageBus;

  beforeEach(() => {
    bus = new AgentMessageBus();
  });

  // ---------------------------------------------------------------------------
  // send — agent-level
  // ---------------------------------------------------------------------------

  describe("send to agent", () => {
    it("delivers a message to a subscribed agent handler", () => {
      const handler = vi.fn();
      bus.subscribe("agent-a", handler);

      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "hello",
      });

      expect(delivery.delivered).toBe(true);
      expect(delivery.messageId).toBeDefined();
      expect(handler).toHaveBeenCalledTimes(1);

      const msg: AgentMessage = handler.mock.calls[0][0];
      expect(msg.fromAgentId).toBe("agent-b");
      expect(msg.toAgentId).toBe("agent-a");
      expect(msg.content).toBe("hello");
      expect(msg.timestamp).toBeInstanceOf(Date);
    });

    it("delivers to multiple handlers for the same agent", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.subscribe("agent-a", h1);
      bus.subscribe("agent-a", h2);

      bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "multi",
      });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it("queues as pending when no handler is registered", () => {
      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "pending msg",
      });

      expect(delivery.delivered).toBe(false);

      const pending = bus.getPending("agent-a");
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe("pending msg");
    });

    it("preserves metadata in delivered messages", () => {
      const handler = vi.fn();
      bus.subscribe("agent-a", handler);

      bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "with meta",
        metadata: { priority: "high", tags: ["urgent"] },
      });

      const msg: AgentMessage = handler.mock.calls[0][0];
      expect(msg.metadata).toEqual({ priority: "high", tags: ["urgent"] });
    });

    it("assigns unique IDs to each message", () => {
      const handler = vi.fn();
      bus.subscribe("agent-a", handler);

      const d1 = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "first",
      });
      const d2 = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "second",
      });

      expect(d1.messageId).not.toBe(d2.messageId);
    });
  });

  // ---------------------------------------------------------------------------
  // send — session-level
  // ---------------------------------------------------------------------------

  describe("send to session", () => {
    it("delivers a message to a subscribed session handler", () => {
      const handler = vi.fn();
      bus.subscribeSession("session-1", handler);

      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "session msg",
      });

      expect(delivery.delivered).toBe(true);
      expect(delivery.sessionId).toBe("session-1");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does NOT fall back to agent handler when toSessionId is set", () => {
      const agentHandler = vi.fn();
      bus.subscribe("agent-a", agentHandler);

      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-unknown",
        content: "session only",
      });

      expect(delivery.delivered).toBe(false);
      expect(agentHandler).not.toHaveBeenCalled();
    });

    it("queues as pending when no session handler is registered", () => {
      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "pending session msg",
      });

      expect(delivery.delivered).toBe(false);
      expect(delivery.sessionId).toBe("session-1");

      const pending = bus.getPending("agent-a", "session-1");
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe("pending session msg");
    });
  });

  // ---------------------------------------------------------------------------
  // subscribe / unsubscribe
  // ---------------------------------------------------------------------------

  describe("subscribe / unsubscribe", () => {
    it("unsubscribe stops future message delivery", () => {
      const handler = vi.fn();
      const unsubscribe = bus.subscribe("agent-a", handler);

      bus.send({ fromAgentId: "agent-b", toAgentId: "agent-a", content: "1" });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.send({ fromAgentId: "agent-b", toAgentId: "agent-a", content: "2" });
      expect(handler).toHaveBeenCalledTimes(1); // not called again
    });

    it("flushes pending messages when a handler subscribes", () => {
      // Send before any handler is registered — should queue
      bus.send({ fromAgentId: "agent-b", toAgentId: "agent-a", content: "queued" });
      expect(bus.getPending("agent-a")).toHaveLength(1);

      const handler = vi.fn();
      bus.subscribe("agent-a", handler);

      // Pending should be flushed
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].content).toBe("queued");
      expect(bus.getPending("agent-a")).toHaveLength(0);
    });

    it("flushes pending session messages when a session handler subscribes", () => {
      bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "queued-s",
      });
      expect(bus.getPending("agent-a", "session-1")).toHaveLength(1);

      const handler = vi.fn();
      bus.subscribeSession("session-1", handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].content).toBe("queued-s");
      expect(bus.getPending("agent-a", "session-1")).toHaveLength(0);
    });

    it("unsubscribeSession stops future delivery", () => {
      const handler = vi.fn();
      const unsubscribe = bus.subscribeSession("session-1", handler);

      bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "first",
      });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "second",
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // broadcast
  // ---------------------------------------------------------------------------

  describe("broadcast", () => {
    it("sends to all registered agents except the sender", () => {
      const hA = vi.fn();
      const hB = vi.fn();
      const hC = vi.fn();
      bus.subscribe("agent-a", hA);
      bus.subscribe("agent-b", hB);
      bus.subscribe("agent-c", hC);

      const deliveries = bus.broadcast("agent-a", "announcement");

      // Should deliver to agent-b and agent-c, but NOT agent-a
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.delivered)).toBe(true);

      expect(hA).not.toHaveBeenCalled();
      expect(hB).toHaveBeenCalledTimes(1);
      expect(hC).toHaveBeenCalledTimes(1);

      expect(hB.mock.calls[0][0].content).toBe("announcement");
      expect(hB.mock.calls[0][0].fromAgentId).toBe("agent-a");
    });

    it("returns empty array when no other agents are registered", () => {
      bus.subscribe("agent-a", vi.fn());
      const deliveries = bus.broadcast("agent-a", "alone");
      expect(deliveries).toHaveLength(0);
    });

    it("includes metadata in broadcast messages", () => {
      const handler = vi.fn();
      bus.subscribe("agent-b", handler);

      bus.broadcast("agent-a", "with meta", { level: "info" });

      const msg: AgentMessage = handler.mock.calls[0][0];
      expect(msg.metadata).toEqual({ level: "info" });
    });
  });

  // ---------------------------------------------------------------------------
  // getPending
  // ---------------------------------------------------------------------------

  describe("getPending", () => {
    it("returns empty array when no pending messages", () => {
      expect(bus.getPending("agent-a")).toEqual([]);
    });

    it("returns pending messages for an agent", () => {
      bus.send({ fromAgentId: "agent-b", toAgentId: "agent-a", content: "p1" });
      bus.send({ fromAgentId: "agent-c", toAgentId: "agent-a", content: "p2" });

      const pending = bus.getPending("agent-a");
      expect(pending).toHaveLength(2);
      expect(pending[0].content).toBe("p1");
      expect(pending[1].content).toBe("p2");
    });

    it("returns a copy (does not expose internal array)", () => {
      bus.send({ fromAgentId: "agent-b", toAgentId: "agent-a", content: "p1" });

      const pending1 = bus.getPending("agent-a");
      const pending2 = bus.getPending("agent-a");
      expect(pending1).not.toBe(pending2); // different array references
      expect(pending1).toEqual(pending2);   // same content
    });

    it("returns pending messages for a session", () => {
      bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "sp1",
      });

      const pending = bus.getPending("agent-a", "session-1");
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe("sp1");
    });
  });

  // ---------------------------------------------------------------------------
  // Integration with AcpSessionManager
  // ---------------------------------------------------------------------------

  describe("AcpSessionManager integration", () => {
    it("accepts an AcpSessionManager in the constructor", () => {
      const sessionManager = new AcpSessionManager(makeConfig());
      const busWithManager = new AgentMessageBus(sessionManager);

      // Should not throw — message bus is usable
      const handler = vi.fn();
      busWithManager.subscribe("claude", handler);

      busWithManager.send({
        fromAgentId: "codex",
        toAgentId: "claude",
        content: "hello from codex",
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("works without an AcpSessionManager", () => {
      const busNoManager = new AgentMessageBus();
      const handler = vi.fn();
      busNoManager.subscribe("agent-a", handler);

      busNoManager.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "no manager",
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Message delivery status
  // ---------------------------------------------------------------------------

  describe("message delivery status", () => {
    it("reports delivered: true when handler exists", () => {
      bus.subscribe("agent-a", vi.fn());

      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "test",
      });

      expect(delivery.delivered).toBe(true);
      expect(delivery.messageId).toBeDefined();
    });

    it("reports delivered: false when no handler exists", () => {
      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        content: "test",
      });

      expect(delivery.delivered).toBe(false);
    });

    it("reports sessionId when sending to a specific session", () => {
      bus.subscribeSession("session-1", vi.fn());

      const delivery = bus.send({
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        toSessionId: "session-1",
        content: "session test",
      });

      expect(delivery.sessionId).toBe("session-1");
    });
  });
});
