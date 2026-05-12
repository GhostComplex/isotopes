// src/http/server.ts — HTTP server for the Isotopes REST API (Hono-based).

import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import { createLogger } from "../logging/logger.js";
import type { CronScheduler } from "../automation/cron-job.js";
import type { SessionStoreManager } from "../agent/pi/session-store.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { Gateway } from "../gateway/index.js";
import { registerCronRoutes } from "./cron.js";
import { registerStatusRoutes } from "./status.js";
import { registerSessionRoutes } from "./sessions.js";
import { matchUIEntry, type UIEntry } from "../extensions/ui/loader.js";

const log = createLogger("api:server");

export interface ApiServerConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
}

export interface ApiServerDeps {
  cronScheduler: CronScheduler;
  uiEntries?: UIEntry[];
  sessionStoreManager?: SessionStoreManager;
  agentRuntime?: AgentRuntime;
  gateway?: Gateway;
}

/** Shared shape passed to per-file route registrars. */
export interface RouteDeps {
  cronScheduler: CronScheduler;
  sessionStoreManager?: SessionStoreManager;
  agentRuntime?: AgentRuntime;
  gateway?: Gateway;
}

export class ApiServer {
  private server: ServerType | null = null;
  private app: Hono;

  constructor(
    private config: ApiServerConfig,
    deps: ApiServerDeps,
  ) {
    const routeDeps: RouteDeps = {
      cronScheduler: deps.cronScheduler,
      sessionStoreManager: deps.sessionStoreManager,
      agentRuntime: deps.agentRuntime,
      gateway: deps.gateway,
    };
    const uiEntries = deps.uiEntries ?? [];

    this.app = new Hono();

    // CORS — preflight handled automatically.
    this.app.use(
      "*",
      cors({
        origin: this.config.corsOrigins ?? ["*"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        maxAge: 86400,
      }),
    );

    // Request logging.
    this.app.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      const ms = Date.now() - start;
      log.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
    });

    // Mount UI extensions and a small landing page at /ui.
    if (uiEntries.length > 0) {
      this.app.get("/ui", (c) => c.html(uiIndexHtml(uiEntries)));
      this.app.get("/ui/", (c) => c.html(uiIndexHtml(uiEntries)));
      for (const entry of uiEntries) {
        // Serve every file under the entry's static dir, with optional SPA fallback.
        this.app.use(
          `${entry.mountPath}/*`,
          serveStatic({
            root: path.relative(process.cwd(), entry.staticDir) || ".",
            rewriteRequestPath: (p) => p.slice(entry.mountPath.length) || "/",
            ...(entry.spaFallback ? { onNotFound: (_p, c) => { void c; } } : {}),
          }),
        );
      }
      // SPA fallback: any unhandled UI path → entry's index.html
      for (const entry of uiEntries) {
        if (!entry.spaFallback) continue;
        this.app.get(`${entry.mountPath}/*`, async (c) => {
          const matched = matchUIEntry(uiEntries, c.req.path);
          if (!matched) return c.notFound();
          // serveStatic above already handled real files; this catches unmatched paths.
          const indexPath = path.join(matched.staticDir, "index.html");
          try {
            const fs = await import("node:fs/promises");
            const data = await fs.readFile(indexPath);
            return c.body(data, 200, { "Content-Type": "text/html; charset=utf-8" });
          } catch {
            return c.notFound();
          }
        });
      }
    }

    // Register API routes.
    registerCronRoutes(this.app, routeDeps);
    registerStatusRoutes(this.app, routeDeps);
    registerSessionRoutes(this.app, routeDeps);

    // 404 fallback.
    this.app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}`, status: 404 }, 404));

    // Catch-all error handler.
    this.app.onError((err, c) => {
      const message = err instanceof Error ? err.message : "Internal server error";
      log.error("Route error:", err);
      return c.json({ error: message, status: 500 }, 500);
    });
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("API server is already running");
    }
    const host = this.config.host ?? "127.0.0.1";
    const port = this.config.port;

    return new Promise<void>((resolve, reject) => {
      try {
        this.server = serve(
          { fetch: this.app.fetch, port, hostname: host },
          () => {
            log.info(`API server listening on http://${host}:${port}`);
            resolve();
          },
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        if (err) {
          reject(err);
        } else {
          log.info("API server stopped");
          resolve();
        }
      });
    });
  }

  isListening(): boolean {
    return this.server !== null;
  }

  address(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }
}

function uiIndexHtml(entries: UIEntry[]): string {
  const escHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const links = entries
    .map((e) => `<li><a href="${escHtml(e.mountPath)}">${escHtml(e.id)}</a></li>`)
    .join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Isotopes UI</title></head><body><h1>Isotopes UI</h1><ul>${links}</ul></body></html>`;
}
