// src/api/routes.test.ts — Unit tests for REST route handlers

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { ApiServer } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";

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

describe("API routes", () => {
  let server: ApiServer;
  let cronScheduler: CronScheduler;

  beforeEach(async () => {
    cronScheduler = new CronScheduler();
    server = new ApiServer({ port: 0 }, { cronScheduler });
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

  describe("GET /api/sessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/sessions");
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns 404 for unknown session", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/sessions/nonexistent");
      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("not found");
    });
  });

  describe("GET /api/cron", () => {
    it("returns empty array when no jobs exist", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/cron");
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it("returns registered cron jobs", async () => {
      cronScheduler.register({
        name: "standup",
        expression: "0 9 * * 1-5",
        agentId: "claude",
        action: { type: "message", content: "Good morning!" },
        enabled: true,
      });

      const { status, data } = await request(getPort(), "GET", "/api/cron");
      expect(status).toBe(200);
      const jobs = data as Array<{ name: string; agentId: string }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("standup");
      expect(jobs[0].agentId).toBe("claude");
    });
  });

  describe("POST /api/cron", () => {
    it("creates a new cron job", async () => {
      const { status, data } = await request(getPort(), "POST", "/api/cron", {
        name: "daily-report",
        expression: "0 17 * * 1-5",
        agentId: "claude",
        action: { type: "prompt", prompt: "Generate daily report" },
      });

      expect(status).toBe(201);
      const body = data as { id: string; name: string; enabled: boolean };
      expect(body.id).toMatch(/^cron_/);
      expect(body.name).toBe("daily-report");
      expect(body.enabled).toBe(true);

      expect(cronScheduler.listJobs()).toHaveLength(1);
    });

    it("returns 400 when required fields are missing", async () => {
      const { status } = await request(getPort(), "POST", "/api/cron", {
        name: "incomplete",
      });
      expect(status).toBe(400);
    });

    it("returns 400 when action is missing", async () => {
      const { status } = await request(getPort(), "POST", "/api/cron", {
        name: "no-action",
        expression: "0 9 * * *",
        agentId: "claude",
      });
      expect(status).toBe(400);
    });

    it("returns 500 for invalid cron expression", async () => {
      const { status } = await request(getPort(), "POST", "/api/cron", {
        name: "bad-cron",
        expression: "invalid",
        agentId: "claude",
        action: { type: "message", content: "test" },
      });
      expect(status).toBe(500);
    });
  });

  describe("DELETE /api/cron/:id", () => {
    it("deletes an existing cron job", async () => {
      const job = cronScheduler.register({
        name: "to-delete",
        expression: "0 9 * * *",
        agentId: "claude",
        action: { type: "message", content: "test" },
        enabled: true,
      });

      const { status, data } = await request(getPort(), "DELETE", `/api/cron/${job.id}`);
      expect(status).toBe(200);
      expect((data as { ok: boolean }).ok).toBe(true);

      expect(cronScheduler.getJob(job.id)).toBeUndefined();
    });

    it("returns 404 for unknown job", async () => {
      const { status } = await request(getPort(), "DELETE", "/api/cron/nonexistent");
      expect(status).toBe(404);
    });
  });

  describe("GET /api/config", () => {
    it("returns 501 when config reloader is not available", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/config");
      expect(status).toBe(501);
      expect((data as { error: string }).error).toContain("not available");
    });
  });

  describe("PUT /api/config", () => {
    it("returns 501 when config reloader is not available", async () => {
      const { status } = await request(getPort(), "PUT", "/api/config");
      expect(status).toBe(501);
    });
  });

  describe("GET /api/status", () => {
    it("reflects cron count", async () => {
      cronScheduler.register({
        name: "job1",
        expression: "0 9 * * *",
        agentId: "claude",
        action: { type: "message", content: "test" },
        enabled: true,
      });

      const { status, data } = await request(getPort(), "GET", "/api/status");
      expect(status).toBe(200);
      const body = data as { cronJobs: number };
      expect(body.cronJobs).toBe(1);
    });
  });
});
