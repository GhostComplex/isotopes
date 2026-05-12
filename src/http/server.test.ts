// src/http/server.test.ts — Factory-level concerns for createApi (404, CORS, error envelope)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApi } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";
import { startTestServer, request, type TestServer } from "./test-helpers.js";

describe("createApi", () => {
  let ts: TestServer;

  beforeEach(async () => {
    const app = createApi({ cronScheduler: new CronScheduler(async () => {}) });
    ts = await startTestServer(app);
  });

  afterEach(() => ts.close());

  it("returns 404 for unknown path", async () => {
    const { status, data } = await request(ts.port, "GET", "/api/nonexistent");
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("No route");
  });

  it("handles CORS preflight", async () => {
    const { status } = await request(ts.port, "OPTIONS", "/api/status");
    expect(status).toBe(204);
  });
});
