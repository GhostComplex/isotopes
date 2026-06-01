import { serve, type ServerType } from "@hono/node-server";
import type { CronScheduler } from "../automation/cron-job.js";
import type { Gateway } from "../gateway/index.js";
import { createApi } from "./server.js";
import { getApiPort } from "../utils/api-client.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("api-server");

export interface ApiServerDeps {
  cronScheduler: CronScheduler;
  gateway: Gateway;
}

export class ApiServer {
  private server: ServerType | undefined;
  private running = false;
  private readonly deps: ApiServerDeps;
  private readonly port: number;

  constructor(deps: ApiServerDeps) {
    this.deps = deps;
    this.port = getApiPort();
  }

  async start(): Promise<void> {
    if (this.running) return;

    const api = createApi(this.deps);
    return new Promise<void>((resolve) => {
      this.server = serve({ fetch: api.fetch, port: this.port, hostname: "127.0.0.1" }, () => {
        log.info("API server listening", { url: `http://127.0.0.1:${this.port}` });
        this.running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    return new Promise<void>((resolve) => {
      this.server!.close((err) => {
        if (err) log.warn("API server close error", { error: err });
        this.server = undefined;
        this.running = false;
        resolve();
      });
    });
  }
}
