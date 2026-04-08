// src/api/middleware.ts — HTTP middleware for the Isotopes REST API
// CORS, JSON body parsing, error handling, and request logging.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../core/logger.js";

const log = createLogger("api");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed request with body and route params */
export interface ApiRequest extends IncomingMessage {
  /** Parsed JSON body (populated by bodyParser middleware) */
  body?: unknown;
  /** Route parameters extracted from URL pattern matching */
  params: Record<string, string>;
  /** Parsed URL pathname */
  pathname: string;
}

/** Standard JSON error response */
export interface ApiError {
  error: string;
  status: number;
}

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

/**
 * Apply CORS headers to a response.
 * Handles preflight OPTIONS requests automatically.
 * Returns true if the request was a preflight (caller should stop processing).
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[],
): boolean {
  const origin = req.headers.origin;

  if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// JSON body parser
// ---------------------------------------------------------------------------

/**
 * Parse the request body as JSON.
 * Sets `req.body` with the parsed result.
 * Returns null on success, or an error message on failure.
 */
export async function parseJsonBody(req: ApiRequest, maxBytes = 1_048_576): Promise<string | null> {
  // Only parse for methods that typically have bodies
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") {
    return null;
  }

  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("application/json")) {
    // No JSON content-type — skip parsing (body stays undefined)
    return null;
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve("Request body too large");
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        req.body = JSON.parse(raw);
        resolve(null);
      } catch {
        resolve("Invalid JSON in request body");
      }
    });

    req.on("error", () => {
      resolve("Error reading request body");
    });
  });
}

// ---------------------------------------------------------------------------
// JSON response helpers
// ---------------------------------------------------------------------------

/** Send a JSON response with the given status code */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Send a JSON error response */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message, status });
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

/** Catch-all error handler for route handlers */
export function handleRouteError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : "Internal server error";
  log.error("Route error:", err);
  sendError(res, 500, message);
}

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------

/** Log an incoming request with timing */
export function logRequest(req: IncomingMessage, res: ServerResponse): void {
  const start = Date.now();
  const { method, url } = req;

  res.on("finish", () => {
    const duration = Date.now() - start;
    log.info(`${method} ${url} ${res.statusCode} ${duration}ms`);
  });
}
