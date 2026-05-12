import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApi } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";
import { startTestServer, request, createStubGateway, type TestServer } from "./test-helpers.js";

describe("/api/cron", () => {
  let ts: TestServer;
  let cronScheduler: CronScheduler;

  beforeEach(async () => {
    cronScheduler = new CronScheduler(async () => {});
    ts = await startTestServer(createApi({ cronScheduler, gateway: createStubGateway() }));
  });

  afterEach(() => ts.close());

  describe("GET /api/cron", () => {
    it("returns empty array when no jobs exist", async () => {
      const { status, data } = await request(ts.port, "GET", "/api/cron");
      expect(status).toBe(200);
      expect(data).toEqual({ items: [] });
    });

    it("returns registered cron jobs", async () => {
      cronScheduler.register({
        name: "standup",
        expression: "0 9 * * 1-5",
        agentId: "claude",
        action: { type: "message", content: "Good morning!" },
        enabled: true,
      });
      const { status, data } = await request(ts.port, "GET", "/api/cron");
      expect(status).toBe(200);
      const jobs = (data as { items: Array<{ name: string; agentId: string }> }).items;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("standup");
      expect(jobs[0].agentId).toBe("claude");
    });
  });

  describe("POST /api/cron", () => {
    it("creates a new cron job", async () => {
      const { status, data } = await request(ts.port, "POST", "/api/cron", {
        name: "daily-report",
        expression: "0 17 * * 1-5",
        agentId: "claude",
        action: { type: "prompt", prompt: "Generate daily report" },
      });
      expect(status).toBe(201);
      const body = data as { id: string; name: string; enabled: boolean };
      expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(body.name).toBe("daily-report");
      expect(body.enabled).toBe(true);
      expect(cronScheduler.listJobs()).toHaveLength(1);
    });

    it("returns 400 when required fields are missing", async () => {
      const { status } = await request(ts.port, "POST", "/api/cron", { name: "incomplete" });
      expect(status).toBe(400);
    });

    it("returns 400 when action is missing", async () => {
      const { status } = await request(ts.port, "POST", "/api/cron", {
        name: "no-action",
        expression: "0 9 * * *",
        agentId: "claude",
      });
      expect(status).toBe(400);
    });

    it("returns 500 for invalid cron expression", async () => {
      const { status } = await request(ts.port, "POST", "/api/cron", {
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
      const { status, data } = await request(ts.port, "DELETE", `/api/cron/${job.id}`);
      expect(status).toBe(200);
      expect((data as { ok: boolean }).ok).toBe(true);
      expect(cronScheduler.listJobs()).toHaveLength(0);
    });

    it("returns 404 for unknown job", async () => {
      const { status } = await request(ts.port, "DELETE", "/api/cron/nonexistent");
      expect(status).toBe(404);
    });
  });
});
