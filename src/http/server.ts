import { Hono } from "hono";
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

export interface ApiDeps {
  cronScheduler: CronScheduler;
  uiEntries?: UIEntry[];
  sessionStoreManager?: SessionStoreManager;
  agentRuntime?: AgentRuntime;
  gateway?: Gateway;
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: ["*"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    }),
  );

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    log.info(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
  });

  mountUI(app, deps.uiEntries ?? []);

  registerCronRoutes(app, deps);
  registerStatusRoutes(app, deps);
  registerSessionRoutes(app, deps);

  app.notFound((c) =>
    c.json({ error: `No route for ${c.req.method} ${c.req.path}`, status: 404 }, 404),
  );

  app.onError((err, c) => {
    log.error("Route error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Internal server error", status: 500 },
      500,
    );
  });

  return app;
}

function mountUI(app: Hono, entries: UIEntry[]): void {
  if (entries.length === 0) return;

  app.get("/ui", (c) => c.html(uiIndexHtml(entries)));
  app.get("/ui/", (c) => c.html(uiIndexHtml(entries)));

  for (const entry of entries) {
    app.use(
      `${entry.mountPath}/*`,
      serveStatic({
        root: path.relative(process.cwd(), entry.staticDir) || ".",
        rewriteRequestPath: (p) => p.slice(entry.mountPath.length) || "/",
      }),
    );

    if (entry.spaFallback) {
      app.get(`${entry.mountPath}/*`, async (c) => {
        const matched = matchUIEntry(entries, c.req.path);
        if (!matched) return c.notFound();
        try {
          const fs = await import("node:fs/promises");
          const data = await fs.readFile(path.join(matched.staticDir, "index.html"));
          return c.body(data, 200, { "Content-Type": "text/html; charset=utf-8" });
        } catch {
          return c.notFound();
        }
      });
    }
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
