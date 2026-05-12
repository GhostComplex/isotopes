// src/plugins/http/server.ts — HTTP server for the Isotopes REST API
// Minimal server built on Node.js built-in http module (no Express).

import http from "node:http";
import path from "node:path";
import { createLogger } from "../../logging/logger.js";
import type { CronScheduler } from "../../automation/cron-job.js";
import type { SessionStoreManager } from "../../agent/pi/session-store.js";
import {
  applyCors,
  parseJsonBody,
  sendError,
  handleRouteError,
  logRequest,
  type ApiRequest,
} from "./middleware.js";
import { matchRoute, type RouteDeps } from "./routes.js";
import { serveStaticFile } from "./static.js";
import { matchUIEntry, type UIEntry } from "../../extensions/ui/loader.js";

import "./cron.js";
import "./logs.js";
import "./status.js";
import "./sessions.js";

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
  agentRuntime?: import("../../agent/runtime.js").AgentRuntime;
  gateway?: import("../../gateway/index.js").Gateway;
}

export class ApiServer {
  private server: http.Server | null = null;
  private deps: RouteDeps;
  private uiEntries: UIEntry[];

  constructor(
    private config: ApiServerConfig,
    deps: ApiServerDeps,
  ) {
    this.uiEntries = deps.uiEntries ?? [];
    this.deps = {
      cronScheduler: deps.cronScheduler,
      sessionStoreManager: deps.sessionStoreManager,
      agentRuntime: deps.agentRuntime,
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("API server is already running");
    }

    const host = this.config.host ?? "127.0.0.1";
    const corsOrigins = this.config.corsOrigins ?? ["*"];

    this.server = http.createServer(async (rawReq, res) => {
      logRequest(rawReq, res);

      if (applyCors(rawReq, res, corsOrigins)) return;

      const req = rawReq as ApiRequest;
      const url = new URL(req.url ?? "/", `http://${host}`);
      req.pathname = url.pathname;
      req.params = {};

      const bodyError = await parseJsonBody(req);
      if (bodyError) {
        sendError(res, 400, bodyError);
        return;
      }

      if (this.uiEntries.length > 0) {
        if (req.pathname === "/ui" || req.pathname === "/ui/") {
          const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          const links = this.uiEntries
            .map((e) => `<li><a href="${escHtml(e.mountPath)}">${escHtml(e.id)}</a></li>`)
            .join("\n");
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Isotopes UI</title></head><body><h1>Isotopes UI</h1><ul>${links}</ul></body></html>`;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }

        const uiMatch = matchUIEntry(this.uiEntries, req.pathname);
        if (uiMatch) {
          const relativePath = req.pathname.slice(uiMatch.mountPath.length) || "/index.html";
          const filePath = path.join(uiMatch.staticDir, relativePath);
          const served = await serveStaticFile(res, filePath, uiMatch.staticDir, uiMatch.spaFallback);
          if (served) return;
          sendError(res, 404, `Not found: ${req.pathname}`);
          return;
        }
      }

      const method = req.method ?? "GET";
      const matched = matchRoute(method, req.pathname);

      if (!matched) {
        sendError(res, 404, `No route for ${method} ${req.pathname}`);
        return;
      }

      req.params = matched.params;

      try {
        await matched.handler(req, res, this.deps);
      } catch (err) {
        handleRouteError(res, err);
      }
    });

    return new Promise<void>((resolve, reject) => {
      const server = this.server!;

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.config.port, host, () => {
        log.info(`API server listening on http://${host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   * Resolves once all connections are closed.
   */
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

  /** Check whether the server is currently listening. */
  isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Get the address the server is bound to (or null if not listening). */
  address(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }
}
