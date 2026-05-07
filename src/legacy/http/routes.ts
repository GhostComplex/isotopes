// src/plugins/http/routes.ts — Route registry (addRoute / matchRoute)

import type { ServerResponse } from "node:http";

import type { CronScheduler } from "../../automation/cron-job.js";
import type { SessionStoreManager } from "../../agent/runners/pi/session-store.js";
import type { AgentRuntime } from "../../agent/runtime.js";
import type { ApiRequest } from "./middleware.js";

/** Dependencies injected into route handlers. */
export interface RouteDeps {
  cronScheduler: CronScheduler;
  sessionStoreManager?: SessionStoreManager;
  agentRuntime?: AgentRuntime;
}

/** Handler function for a matched API route. */
export type RouteHandler = (
  req: ApiRequest,
  res: ServerResponse,
  deps: RouteDeps,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------

const routes: Route[] = [];

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const regexStr = path.replace(/:([a-zA-Z_]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
  });
}

/**
 * Match an incoming request to a registered route.
 * Returns the matched route and extracted params, or undefined.
 */
export function matchRoute(
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    return { handler: route.handler, params };
  }
  return undefined;
}
