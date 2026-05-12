// src/http/server.test.ts — Unit tests for createApi + Hono app behavior.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { serve, type ServerType } from "@hono/node-server";
import { createApi } from "./server.js";
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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: unknown;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("createApi", () => {
  let server: ServerType;
  let port: number;

  beforeEach(async () => {
    const cronScheduler = new CronScheduler(async () => {});
    const app = createApi({ cronScheduler });
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /api/status returns daemon status", async () => {
    const { status, data } = await request(port, "GET", "/api/status");
    expect(status).toBe(200);
    const body = data as { version: string; uptime: number; cronJobs: number };
    expect(body.version).toBeDefined();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.cronJobs).toBe(0);
  });

  it("returns 404 for unknown path", async () => {
    const { status, data } = await request(port, "GET", "/api/nonexistent");
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("No route");
  });

  it("handles CORS preflight", async () => {
    const { status } = await request(port, "OPTIONS", "/api/status");
    expect(status).toBe(204);
  });
});
