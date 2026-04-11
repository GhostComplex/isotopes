// src/api/static.ts — Static file server for the Isotopes dashboard
// Serves files from web/dashboard/ for /dashboard/* routes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import type { ApiRequest } from "./middleware.js";

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Root directory
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_ROOT = path.join(__dirname, "../../web/dashboard");

// ---------------------------------------------------------------------------
// Static handler
// ---------------------------------------------------------------------------

/**
 * Try to serve a static file for /dashboard* requests.
 * Returns true if the request was handled, false otherwise.
 */
export async function serveDashboard(
  req: ApiRequest,
  res: ServerResponse,
): Promise<boolean> {
  const { pathname } = req;

  // Only handle /dashboard routes
  if (pathname !== "/dashboard" && !pathname.startsWith("/dashboard/")) {
    return false;
  }

  // Redirect /dashboard to /dashboard/ so relative asset paths resolve correctly
  if (pathname === "/dashboard") {
    res.writeHead(301, { Location: "/dashboard/" });
    res.end();
    return true;
  }

  // Map pathname to file path
  let filePath: string;
  if (pathname === "/dashboard/") {
    filePath = path.join(DASHBOARD_ROOT, "index.html");
  } else {
    const relativePath = pathname.slice("/dashboard/".length);
    filePath = path.join(DASHBOARD_ROOT, relativePath);
  }

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(DASHBOARD_ROOT))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  try {
    const content = await readFile(resolved);
    const ext = path.extname(resolved);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
    });
    res.end(content);
    return true;
  } catch {
    // File not found — don't handle, let it fall through to 404
    return false;
  }
}
