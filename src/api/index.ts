// src/api/index.ts — Barrel exports for the API module

export { ApiServer } from "./server.js";
export type { ApiServerConfig } from "./server.js";

export { matchRoute } from "./routes.js";
export type { RouteDeps, RouteHandler } from "./routes.js";

export {
  applyCors,
  parseJsonBody,
  sendJson,
  sendError,
  handleRouteError,
  logRequest,
} from "./middleware.js";
export type { ApiRequest, ApiError } from "./middleware.js";

export { serveDashboard } from "./static.js";
