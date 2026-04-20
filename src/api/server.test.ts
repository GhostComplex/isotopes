// src/api/server.test.ts — Unit tests for the ApiServer

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { ApiServer } from "./server.js";
import { CronScheduler } from "../automation/cron-job.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple HTTP fetch helper that works on raw http module */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiServer", () => {
  let server: ApiServer;
  let cronScheduler: CronScheduler;

  beforeEach(async () => {
    cronScheduler = new CronScheduler();
    // Use port 0 so the OS assigns a free port
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

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("starts and is listening", () => {
      expect(server.isListening()).toBe(true);
    });

    it("reports address after start", () => {
      const addr = server.address();
      expect(addr).not.toBeNull();
      expect(addr!.port).toBeGreaterThan(0);
    });

    it("throws if started twice", async () => {
      await expect(server.start()).rejects.toThrow(/already running/);
    });

    it("stops cleanly", async () => {
      await server.stop();
      expect(server.isListening()).toBe(false);
      expect(server.address()).toBeNull();
    });

    it("stop is idempotent", async () => {
      await server.stop();
      await server.stop(); // should not throw
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/status
  // -----------------------------------------------------------------------

  describe("GET /api/status", () => {
    it("returns daemon status", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/status");
      expect(status).toBe(200);
      const body = data as { version: string; uptime: number; cronJobs: number };
      expect(body.version).toBeDefined();
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.cronJobs).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 404 for unknown routes
  // -----------------------------------------------------------------------

  describe("unknown routes", () => {
    it("returns 404 for unknown path", async () => {
      const { status, data } = await request(getPort(), "GET", "/api/nonexistent");
      expect(status).toBe(404);
      expect((data as { error: string }).error).toContain("No route");
    });
  });

  // -----------------------------------------------------------------------
  // CORS
  // -----------------------------------------------------------------------

  describe("CORS", () => {
    it("handles OPTIONS preflight", async () => {
      const { status } = await request(getPort(), "OPTIONS", "/api/status");
      expect(status).toBe(204);
    });
  });
});
