import path from "node:path";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import { getLogsDir } from "../paths.js";

interface LogsOptions {
  lines: number;
  level?: string;
  follow: boolean;
}

export async function handleLogsCommand(opts: LogsOptions): Promise<void> {
  const logFile = path.join(getLogsDir(), "isotopes.log");

  try {
    await fs.access(logFile);
  } catch {
    console.error(`Log file not found: ${logFile}`);
    console.error("Has the daemon ever run? Run `isotopes` in the foreground first.");
    process.exit(1);
  }

  const matchesLevel = (line: string): boolean => {
    if (!opts.level) return true;
    return line.toUpperCase().includes(opts.level.toUpperCase());
  };

  if (opts.follow) {
    let position = (await fs.stat(logFile)).size;
    let reading = false;
    let trailingFragment = "";

    const readNew = () => {
      if (reading) return;
      let currentSize: number;
      try {
        currentSize = nodeFs.statSync(logFile).size;
      } catch {
        return;
      }
      if (currentSize < position) position = 0;
      if (currentSize === position) return;

      reading = true;
      const readStart = position;
      position = currentSize;

      const stream = nodeFs.createReadStream(logFile, { start: readStart, end: currentSize - 1, encoding: "utf-8" });
      let buf = "";
      stream.on("data", (chunk: string | Buffer) => { buf += String(chunk); });
      stream.on("end", () => {
        reading = false;
        const text = trailingFragment + buf;
        const parts = text.split("\n");
        trailingFragment = parts.pop() ?? "";
        for (const line of parts) {
          if (line && matchesLevel(line)) console.log(line);
        }
      });
      stream.on("error", () => { reading = false; });
    };

    nodeFs.watchFile(logFile, { interval: 500 }, () => readNew());
    process.on("SIGINT", () => {
      nodeFs.unwatchFile(logFile);
      process.exit(0);
    });
  } else {
    const content = await fs.readFile(logFile, "utf-8");
    const allLines = content.split("\n").filter(Boolean);
    const filtered = opts.level ? allLines.filter(matchesLevel) : allLines;
    for (const line of filtered.slice(-opts.lines)) {
      console.log(line);
    }
  }
}
