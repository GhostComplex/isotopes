// src/core/logger.ts — Logging system for Isotopes
// Provides structured logging with levels, timestamps, and tags.

/** Log severity level. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Get configured log level from environment */
function getLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVELS) {
    return env as LogLevel;
  }
  // DEBUG=isotopes or DEBUG=* enables debug
  const debug = process.env.DEBUG;
  if (debug === "isotopes" || debug === "*" || debug === "true") {
    return "debug";
  }
  return "info";
}

/** Format timestamp */
function timestamp(): string {
  return new Date().toISOString();
}

/** Format log message */
function format(level: LogLevel, tag: string, message: string): string {
  const levelStr = level.toUpperCase().padEnd(5);
  return `[${timestamp()}] [${levelStr}] [${tag}] ${message}`;
}

/**
 * Tagged logger instance.
 *
 * Messages are formatted with ISO timestamp, level, and tag:
 * `[2024-01-15T10:30:00.000Z] [INFO ] [core] message`
 *
 * Create via {@link createLogger} or use the default {@link logger}.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(subtag: string): Logger;
}

/**
 * Create a tagged logger instance.
 *
 * Log level is determined by the `LOG_LEVEL` environment variable
 * (debug, info, warn, error) or `DEBUG=isotopes` for debug output.
 *
 * @param tag - Short identifier prepended to every log line (e.g. `"core"`, `"discord"`)
 */
export function createLogger(tag: string): Logger {
  const minLevel = LOG_LEVELS[getLogLevel()];

  const log = (level: LogLevel, message: string, args: unknown[]) => {
    if (LOG_LEVELS[level] < minLevel) return;

    const formatted = format(level, tag, message);

    switch (level) {
      case "debug":
        console.debug(formatted, ...args);
        break;
      case "info":
        console.log(formatted, ...args);
        break;
      case "warn":
        console.warn(formatted, ...args);
        break;
      case "error":
        console.error(formatted, ...args);
        break;
    }
  };

  return {
    debug: (msg, ...args) => log("debug", msg, args),
    info: (msg, ...args) => log("info", msg, args),
    warn: (msg, ...args) => log("warn", msg, args),
    error: (msg, ...args) => log("error", msg, args),
    child: (subtag) => createLogger(`${tag}:${subtag}`),
  };
}

/**
 * Default logger for general use.
 */
export const logger = createLogger("isotopes");

// ---------------------------------------------------------------------------
// Pre-configured loggers for core components (lazy-initialized)
// ---------------------------------------------------------------------------

interface LoggerMap {
  core: Logger;
  discord: Logger;
  feishu: Logger;
  agent: Logger;
  session: Logger;
  tools: Logger;
  config: Logger;
}

/** Pre-configured loggers for core Isotopes components. Created on first access. */
export const loggers: LoggerMap = new Proxy({} as Record<string, Logger>, {
  get(cache, prop: string) {
    if (!(prop in cache)) {
      cache[prop] = createLogger(prop);
    }
    return cache[prop];
  },
}) as unknown as LoggerMap;
