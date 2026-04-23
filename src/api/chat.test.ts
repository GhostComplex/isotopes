// src/api/chat.test.ts — Unit tests for chat session creation with sessionKey

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { ApiServer } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";
import { createMockAgentManager } from "../core/test-helpers.js";
import { SessionStoreManager } from "../core/session-store-manager.js";

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("POST /api/chat/sessions — sessionKey", () => {
  let server: ApiServer;
  let agentManager: ReturnType<typeof createMockAgentManager>;
  let sessionStoreManager: SessionStoreManager;

  beforeEach(async () => {
    agentManager = createMockAgentManager();
    sessionStoreManager = new SessionStoreManager();
    server = new ApiServer(
      { port: 0 },
      { cronScheduler: new CronScheduler(), agentManager, sessionStoreManager },
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function getPort(): number {
    const addr = server.address();
    if (!addr) throw new Error("Server not listening");
    return addr.port;
  }

  function agentId(): string {
    return agentManager.list()[0]?.id ?? "mock";
  }

  it("creates a new session without sessionKey (default path)", async () => {
    const { status, data } = await request(getPort(), "POST", "/api/chat/sessions", {
      agentId: agentId(),
    });
    expect(status).toBe(201);
    const body = data as { sessionId: string; agentId: string; resumed: boolean };
    expect(body.sessionId).toBeTruthy();
    expect(body.resumed).toBe(false);
  });

  it("resumes an existing session when same sessionKey is provided", async () => {
    const key = `pet:test-${Date.now()}`;
    const first = await request(getPort(), "POST", "/api/chat/sessions", {
      agentId: agentId(),
      sessionKey: key,
    });
    expect(first.status).toBe(201);
    const firstBody = first.data as { sessionId: string; resumed: boolean };
    expect(firstBody.resumed).toBe(false);

    const second = await request(getPort(), "POST", "/api/chat/sessions", {
      agentId: agentId(),
      sessionKey: key,
    });
    expect(second.status).toBe(200);
    const secondBody = second.data as { sessionId: string; resumed: boolean };
    expect(secondBody.resumed).toBe(true);
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
  });

  it("returns 400 for invalid sessionKey format", async () => {
    const { status, data } = await request(getPort(), "POST", "/api/chat/sessions", {
      agentId: agentId(),
      sessionKey: "no-colon-here",
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("Invalid sessionKey format");
  });

  it("returns 400 for sessionKey exceeding max length", async () => {
    const longKey = "a".repeat(100) + ":" + "b".repeat(100);
    const { status, data } = await request(getPort(), "POST", "/api/chat/sessions", {
      agentId: agentId(),
      sessionKey: longKey,
    });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("max length");
  });
});
