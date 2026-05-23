import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApi } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";
import { startTestServer, request, createStubGateway, type TestServer } from "./test-helpers.js";

describe("GET /api/status", () => {
  let ts: TestServer;
  let cronScheduler: CronScheduler;

  beforeEach(async () => {
    cronScheduler = new CronScheduler(async () => {});
    ts = await startTestServer(createApi({ cronScheduler, gateway: createStubGateway() }));
  });

  afterEach(() => ts.close());

  it("returns daemon status with cronJobs=0 when no jobs registered", async () => {
    const { status, data } = await request(ts.port, "GET", "/api/status");
    expect(status).toBe(200);
    const body = data as { version: string; uptime: number; cronJobs: number };
    expect(body.version).toBeDefined();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.cronJobs).toBe(0);
  });

  it("reflects registered cron job count", async () => {
    cronScheduler.register({
      name: "job1",
      expression: "0 9 * * *",
      agentId: "claude",
      action: { type: "message", content: "test" },
      enabled: true,
    });
    const { status, data } = await request(ts.port, "GET", "/api/status");
    expect(status).toBe(200);
    expect((data as { cronJobs: number }).cronJobs).toBe(1);
  });
});
