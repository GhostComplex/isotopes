// src/core/logger.ts — Logging system for Isotopes
// Provides structured logging with levels, timestamps, and tags.

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
 * Logger instance with tag.
 * Create via `createLogger("tag")` or use the default `logger`.
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
// Pre-configured loggers for core components
// ---------------------------------------------------------------------------

export const loggers = {
  core: createLogger("core"),
  discord: createLogger("discord"),
  agent: createLogger("agent"),
  session: createLogger("session"),
  tools: createLogger("tools"),
  config: createLogger("config"),
};
