// src/plugins/http/logs.ts — Log tailing route

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { addRoute } from "./routes.js";
import { sendJson, handleRouteError } from "./middleware.js";
import { getIsotopesHome, getLogsDir } from "../../core/paths.js";

const LOG_CANDIDATES = [
  () => path.join(getLogsDir(), "isotopes.log"),
  () => path.join(getLogsDir(), "isotopes.out.log"),
  () => path.join(getIsotopesHome(), "isotopes.log"),
];

async function findLogFile(): Promise<string | null> {
  for (const getPath of LOG_CANDIDATES) {
    const p = getPath();
    try {
      await access(p, constants.R_OK);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

function tailFile(filePath: string, lines: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tail", ["-n", lines, filePath], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// GET /api/logs — tail log file
// ---------------------------------------------------------------------------

addRoute("GET", "/api/logs", async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const lines = url.searchParams.get("lines") ?? "100";

  const logPath = await findLogFile();
  if (!logPath) {
    sendJson(res, 200, { logs: "(no log file found)", file: null });
    return;
  }

  try {
    const logs = await tailFile(logPath, lines);
    sendJson(res, 200, { logs, file: logPath });
  } catch (err) {
    handleRouteError(res, err);
  }
});
