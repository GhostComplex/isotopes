import nodeFs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let fileStream: nodeFs.WriteStream | null = null;

function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  if (level && level in LOG_LEVELS) return level as LogLevel;
  return "info";
}

export function enableFileLogging(logDir: string): void {
  nodeFs.mkdirSync(logDir, { recursive: true });
  fileStream = nodeFs.createWriteStream(path.join(logDir, "isotopes.log"), { flags: "a" });
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  const log = (level: LogLevel, message: string, args: unknown[]) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[getLogLevel()]) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] [${tag}] ${message}`;
    const fn = level === "warn" ? console.warn : level === "error" ? console.error : level === "debug" ? console.debug : console.log;
    const suffix = args.length > 0 ? " " + args.map((a) => a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a)).join(" ") : "";
    fn(line + suffix);
    if (fileStream) {
      fileStream.write(line + suffix + "\n");
    }
  };

  return {
    debug: (msg, ...args) => log("debug", msg, args),
    info: (msg, ...args) => log("info", msg, args),
    warn: (msg, ...args) => log("warn", msg, args),
    error: (msg, ...args) => log("error", msg, args),
  };
}
