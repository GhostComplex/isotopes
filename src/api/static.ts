// src/api/static.ts — Static file server for plugin UIs

import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

export async function serveStaticFile(
  res: http.ServerResponse,
  filePath: string,
  rootDir: string,
  spaFallback = false,
): Promise<boolean> {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(rootDir))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return serveStaticFile(res, path.join(resolved, "index.html"), rootDir);
    }

    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
    return true;
  } catch {
    if (spaFallback && !path.extname(resolved)) {
      const indexPath = path.join(rootDir, "index.html");
      try {
        const data = await fs.readFile(indexPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
        return true;
      } catch {
        // fall through
      }
    }
    return false;
  }
}
