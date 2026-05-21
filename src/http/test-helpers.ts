import http from "node:http";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { Gateway } from "../gateway/index.js";

export function createStubGateway(overrides: Partial<Gateway> = {}): Gateway {
  const notImpl = (name: string) => () => {
    throw new Error(`stub gateway: ${name} not implemented`);
  };
  return {
    dispatch: notImpl("dispatch") as Gateway["dispatch"],
    dispatchAndWait: notImpl("dispatchAndWait") as Gateway["dispatchAndWait"],
    abort: async () => {},
    abortByKey: async () => false,
    agentExists: () => false,
    listSessions: async () => [],
    listSessionsForAgent: async () => [],
    getSession: async () => undefined,
    getMessages: async () => undefined,
    subscribe: async () => undefined,
    createOrResumeSession: notImpl("createOrResumeSession") as Gateway["createOrResumeSession"],
    deleteSession: async () => false,
    ...overrides,
  };
}

export interface TestServer {
  server: ServerType;
  port: number;
  close: () => Promise<void>;
}

export async function startTestServer(app: Hono): Promise<TestServer> {
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return {
    server,
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function request(
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
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
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
