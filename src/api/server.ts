// src/api/server.ts — HTTP server for the Isotopes REST API
// Minimal server built on Node.js built-in http module (no Express).

import http from "node:http";
import { createLogger } from "../core/logger.js";
import type { CronScheduler } from "../automation/cron-job.js";
import type { ConfigReloader } from "../workspace/config-reloader.js";
import type { AgentManager, SessionStore } from "../core/types.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import {
  applyCors,
  parseJsonBody,
  sendError,
  handleRouteError,
  logRequest,
  type ApiRequest,
} from "./middleware.js";
import { matchRoute, type RouteDeps } from "./routes.js";
import { serveDashboard, serveChat } from "./static.js";

// Register chat routes (side-effect import)
import "./chat.js";

// Register subagent routes (side-effect import)
import "./subagents.js";

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
 * Exposes endpoints for managing chat / Discord sessions, cron jobs, config, and
 * daemon status. Supports CORS, JSON body parsing, and parameterized routes.
 */
export class ApiServer {
  private server: http.Server | null = null;
  private deps: RouteDeps;

  constructor(
    private config: ApiServerConfig,
    cronScheduler: CronScheduler,
    configReloader?: ConfigReloader,
    agentManager?: AgentManager,
    chatSessionStore?: SessionStore,
    usageTracker?: UsageTracker,
    discordSessionStores?: Map<string, SessionStore>,
  ) {
    this.deps = { cronScheduler, configReloader, agentManager, chatSessionStore, usageTracker, discordSessionStores };
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

      // Static dashboard files (before API route matching)
      if (await serveDashboard(req, res)) {
        return;
      }

      // Static chat files (before API route matching)
      if (await serveChat(req, res)) {
        return;
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
