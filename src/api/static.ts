// src/api/static.ts — Static file server for dashboard
// Serves files from web/ directory for the admin dashboard.

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Web assets directory (relative to src/api/)
const WEB_ROOT = path.resolve(__dirname, "../../web");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Try to serve a static file for the given pathname.
 * Returns true if handled, false if not a static route.
 */
export function serveStatic(
  pathname: string,
  _req: IncomingMessage,
  res: ServerResponse,
): boolean {
  // Only handle /dashboard paths
  if (!pathname.startsWith("/dashboard")) {
    return false;
  }

  // Map /dashboard to /dashboard/index.html
  let filePath: string;
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    filePath = path.join(WEB_ROOT, "dashboard", "index.html");
  } else {
    // /dashboard/foo.js → web/dashboard/foo.js
    const relativePath = pathname.replace(/^\/dashboard/, "/dashboard");
    filePath = path.join(WEB_ROOT, relativePath);
  }

  // Security: prevent directory traversal
  const realPath = path.resolve(filePath);
  if (!realPath.startsWith(WEB_ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  // Check file exists
  if (!fs.existsSync(realPath)) {
    // For SPA routing: if it's not a file with extension, serve index.html
    if (!path.extname(pathname)) {
      const indexPath = path.join(WEB_ROOT, "dashboard", "index.html");
      if (fs.existsSync(indexPath)) {
        serveFile(indexPath, res);
        return true;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return true;
  }

  // Check it's a file, not directory
  const stat = fs.statSync(realPath);
  if (stat.isDirectory()) {
    // Try index.html
    const indexPath = path.join(realPath, "index.html");
    if (fs.existsSync(indexPath)) {
      serveFile(indexPath, res);
      return true;
    }
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Directory listing not allowed");
    return true;
  }

  serveFile(realPath, res);
  return true;
}

function serveFile(filePath: string, res: ServerResponse): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}
