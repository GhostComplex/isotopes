// src/api/server.ts — HTTP server for the Isotopes REST API
// Minimal server built on Node.js built-in http module (no Express).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";
import type { AcpSessionManager } from "../acp/session-manager.js";
import type { CronScheduler } from "../automation/cron-job.js";
import type { ConfigReloader } from "../workspace/config-reloader.js";
import type { AgentManager, SessionStore } from "../core/types.js";
import {
  applyCors,
  parseJsonBody,
  sendError,
  handleRouteError,
  logRequest,
  type ApiRequest,
} from "./middleware.js";
import { matchRoute, type RouteDeps } from "./routes.js";

const log = createLogger("api:server");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the HTTP API server. */
export interface ApiServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: "127.0.0.1") */
  host?: string;
  /** Allowed CORS origins (default: ["*"]) */
  corsOrigins?: string[];
  /** Directory to serve static files from (SPA mode with index.html fallback) */
  staticDir?: string;
}

// ---------------------------------------------------------------------------
// ApiServer
// ---------------------------------------------------------------------------

/**
 * ApiServer — minimal HTTP REST API built on Node.js built-in `http` module.
 *
 * Exposes endpoints for managing ACP sessions, cron jobs, config, and
 * daemon status. Supports CORS, JSON body parsing, and parameterized routes.
 */
export class ApiServer {
  private server: http.Server | null = null;
  private deps: RouteDeps;
  private staticDir: string | undefined;

  constructor(
    private config: ApiServerConfig,
    sessionManager: AcpSessionManager,
    cronScheduler: CronScheduler,
    configReloader?: ConfigReloader,
    opts?: {
      agentManager?: AgentManager;
      sessionStore?: SessionStore;
      sessionStoreForAgent?: (agentId: string) => SessionStore;
    },
  ) {
    this.deps = {
      sessionManager,
      cronScheduler,
      configReloader,
      agentManager: opts?.agentManager,
      sessionStore: opts?.sessionStore,
      sessionStoreForAgent: opts?.sessionStoreForAgent,
    };
    this.staticDir = config.staticDir;
  }

  /**
   * Start the HTTP server.
   * Resolves once the server is listening.
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("API server is already running");
    }

    const host = this.config.host ?? "127.0.0.1";
    const corsOrigins = this.config.corsOrigins ?? ["*"];

    this.server = http.createServer(async (rawReq, res) => {
      // Logging
      logRequest(rawReq, res);

      // CORS
      if (applyCors(rawReq, res, corsOrigins)) {
        return; // preflight handled
      }

      // Augment request
      const req = rawReq as ApiRequest;
      const url = new URL(req.url ?? "/", `http://${host}`);
      req.pathname = url.pathname;
      req.params = {};

      // Parse body
      const bodyError = await parseJsonBody(req);
      if (bodyError) {
        sendError(res, 400, bodyError);
        return;
      }

      // Route matching
      const method = req.method ?? "GET";
      const matched = matchRoute(method, req.pathname);

      if (matched) {
        req.params = matched.params;

        // Execute handler
        try {
          await matched.handler(req, res, this.deps);
        } catch (err) {
          handleRouteError(res, err);
        }
        return;
      }

      // Static file serving (SPA fallback)
      if (this.staticDir && method === "GET" && !req.pathname.startsWith("/api/")) {
        const served = this.serveStatic(req.pathname, res);
        if (served) return;

        // SPA fallback: serve index.html for non-API, non-file paths
        const indexServed = this.serveStatic("/index.html", res);
        if (indexServed) return;
      }

      sendError(res, 404, `No route for ${method} ${req.pathname}`);
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

  // -------------------------------------------------------------------------
  // Static file serving
  // -------------------------------------------------------------------------

  private static MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
  };

  /**
   * Try to serve a static file from the configured staticDir.
   * Returns true if a file was served, false otherwise.
   */
  private serveStatic(pathname: string, res: http.ServerResponse): boolean {
    if (!this.staticDir) return false;

    // Prevent path traversal
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(this.staticDir, safePath);

    // Ensure resolved path is within staticDir
    if (!filePath.startsWith(path.resolve(this.staticDir))) return false;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return false;

      const ext = path.extname(filePath).toLowerCase();
      const contentType = ApiServer.MIME_TYPES[ext] ?? "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
      return true;
    } catch {
      return false;
    }
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
