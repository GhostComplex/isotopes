// src/api/server.ts — HTTP server for the Isotopes REST API
// Minimal server built on Node.js built-in http module (no Express).

import http from "node:http";
import path from "node:path";
import { createLogger } from "../core/logger.js";
import type { CronScheduler } from "../automation/cron-job.js";
import type { ConfigReloader } from "../workspace/config-reloader.js";
import type { DefaultAgentManager } from '../core/agent-manager.js';
import type { SessionStore } from '../core/types.js';
import type { UsageTracker } from "../core/usage-tracker.js";
import type { SessionStoreManager } from "../core/session-store-manager.js";
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
import type { HookRegistry } from "../plugins/hooks.js";
import type { UIRegistry } from "../plugins/ui-registry.js";

// Register subagent routes (side-effect import)
import "./subagents.js";
// Register chat API routes (side-effect import)
import "./chat.js";

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
}

// ---------------------------------------------------------------------------
// ApiServer
// ---------------------------------------------------------------------------

/**
 * ApiServer — minimal HTTP REST API built on Node.js built-in `http` module.
 *
 * Exposes endpoints for managing Discord sessions, cron jobs, config, and
 * daemon status. Supports CORS, JSON body parsing, and parameterized routes.
 */
export interface ApiServerDeps {
  cronScheduler: CronScheduler;
  configReloader?: ConfigReloader;
  agentManager?: DefaultAgentManager;
  usageTracker?: UsageTracker;
  discordSessionStores?: Map<string, SessionStore>;
  uiRegistry?: UIRegistry;
  sessionStoreManager?: SessionStoreManager;
  hooks?: HookRegistry;
}

export class ApiServer {
  private server: http.Server | null = null;
  private deps: RouteDeps;
  private uiRegistry?: UIRegistry;

  constructor(
    private config: ApiServerConfig,
    deps: ApiServerDeps,
  ) {
    this.uiRegistry = deps.uiRegistry;
    this.deps = {
      cronScheduler: deps.cronScheduler,
      configReloader: deps.configReloader,
      agentManager: deps.agentManager,
      usageTracker: deps.usageTracker,
      discordSessionStores: deps.discordSessionStores,
      sessionStoreManager: deps.sessionStoreManager,
      hooks: deps.hooks,
    };
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

      // Plugin UI static files
      if (this.uiRegistry) {
        // Navigation shell
        if (req.pathname === "/ui" || req.pathname === "/ui/") {
          const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          const entries = this.uiRegistry.list();
          const links = entries
            .map((e) => `<li><a href="${escHtml(e.mountPath!)}">${escHtml(e.label)}</a></li>`)
            .join("\n");
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Isotopes UI</title></head><body><h1>Isotopes UI Plugins</h1><ul>${links}</ul></body></html>`;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }

        const uiMatch = this.uiRegistry.match(req.pathname);
        if (uiMatch) {
          const mount = uiMatch.mountPath!;
          const relativePath = req.pathname.slice(mount.length) || "/index.html";
          const filePath = path.join(uiMatch.staticDir, relativePath);
          const served = await serveStaticFile(res, filePath, uiMatch.staticDir, uiMatch.spaFallback ?? false);
          if (served) return;
          sendError(res, 404, `Not found: ${req.pathname}`);
          return;
        }
      }

      // Route matching
      const method = req.method ?? "GET";
      const matched = matchRoute(method, req.pathname);

      if (!matched) {
        sendError(res, 404, `No route for ${method} ${req.pathname}`);
        return;
      }

      req.params = matched.params;

      // Execute handler
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
