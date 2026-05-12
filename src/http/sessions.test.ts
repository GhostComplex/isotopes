import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApi } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";
import { SessionStoreManager } from "../agent/pi/session-store.js";
import { AgentRuntime } from "../agent/runtime.js";
import { createMockSessionStore } from "../test-helpers.js";
import { startTestServer, request, type TestServer } from "./test-helpers.js";

const MOCK_AGENT_ID = "mock";

function makeRuntime(): AgentRuntime {
  const rt = new AgentRuntime({ globalProvider: { type: "anthropic", defaultModel: "claude-opus-4-5" } });
  const agent = {
    id: MOCK_AGENT_ID,
    config: { id: MOCK_AGENT_ID },
    sessionStore: createMockSessionStore() as never,
  };
  rt.registerRunner(MOCK_AGENT_ID, {
    agent: () => agent,
    resolveSessionId: (req) => req.sessionId ?? `mock:${randomUUID()}`,
    async *run() {},
  });
  return rt;
}

describe("/api/sessions", () => {
  describe("without sessionStoreManager", () => {
    let ts: TestServer;

    beforeEach(async () => {
      ts = await startTestServer(createApi({ cronScheduler: new CronScheduler(async () => {}) }));
    });

    afterEach(() => ts.close());

    it("GET /api/sessions returns empty array", async () => {
      const { status, data } = await request(ts.port, "GET", "/api/sessions");
      expect(status).toBe(200);
      expect(data).toEqual({ items: [] });
    });

    it("GET /api/sessions/:agentId/:key returns 503", async () => {
      const { status, data } = await request(ts.port, "GET", "/api/sessions/test-agent/nonexistent");
      expect(status).toBe(503);
      expect((data as { error: string }).error).toContain("not available");
    });
  });

  describe("POST /api/sessions/:agentId — create/resume", () => {
    let ts: TestServer;

    beforeEach(async () => {
      const app = createApi({
        cronScheduler: new CronScheduler(async () => {}),
        agentRuntime: makeRuntime(),
        sessionStoreManager: new SessionStoreManager(),
      });
      ts = await startTestServer(app);
    });

    afterEach(() => ts.close());

    it("creates a new session without sessionKey (default path)", async () => {
      const { status, data } = await request(ts.port, "POST", `/api/sessions/${MOCK_AGENT_ID}`, {});
      expect(status).toBe(201);
      const body = data as { key: string; agentId: string; resumed: boolean };
      expect(body.key).toBeTruthy();
      expect(body.resumed).toBe(false);
    });

    it("resumes an existing session when same sessionKey is provided", async () => {
      const key = `test-${Date.now()}`;
      const first = await request(ts.port, "POST", `/api/sessions/${MOCK_AGENT_ID}`, { sessionKey: key });
      expect(first.status).toBe(201);
      expect((first.data as { resumed: boolean }).resumed).toBe(false);

      const second = await request(ts.port, "POST", `/api/sessions/${MOCK_AGENT_ID}`, { sessionKey: key });
      expect(second.status).toBe(200);
      const body = second.data as { key: string; resumed: boolean };
      expect(body.resumed).toBe(true);
      expect(body.key).toBe(key);
    });

    it("returns 400 for sessionKey exceeding max length", async () => {
      const { status, data } = await request(ts.port, "POST", `/api/sessions/${MOCK_AGENT_ID}`, {
        sessionKey: "a".repeat(200),
      });
      expect(status).toBe(400);
      expect((data as { error: string }).error).toContain("max length");
    });
  });
});
