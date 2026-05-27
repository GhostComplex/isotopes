import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLogsPath } from "../utils/paths.js";
import * as launchd from "../daemon/launchd.js";
import type { LaunchAgentConfig } from "../daemon/launchd.js";

const SERVICE_NAME = "ai.isotopes.daemon";

function makeServiceConfig(): LaunchAgentConfig {
  return {
    name: SERVICE_NAME,
    execPath: process.argv[0],
    cliPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js"),
    logPath: path.join(getLogsPath(), "isotopes.log"),
  };
}

export async function handleServiceCommand(args: string[]): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("`isotopes service` is macOS-only. Run isotopes in the foreground or supervise it yourself on this platform.");
    process.exit(1);
  }

  const sub = args[0];
  switch (sub) {
    case "install":
      await launchd.install(makeServiceConfig());
      console.log(`LaunchAgent "${SERVICE_NAME}" installed and running`);
      break;

    case "uninstall":
      await launchd.uninstall(SERVICE_NAME);
      console.log(`LaunchAgent "${SERVICE_NAME}" removed`);
      break;

    case "restart":
      await launchd.restart(SERVICE_NAME);
      console.log(`LaunchAgent "${SERVICE_NAME}" restarted`);
      break;

    case "status": {
      const s = await launchd.status(SERVICE_NAME);
      switch (s.state) {
        case "running":
          console.log(`Running (pid ${s.pid})`);
          break;
        case "loaded":
          console.log("Loaded but no live process — KeepAlive should respawn shortly");
          break;
        case "not-installed":
          console.log("Not installed");
          break;
      }
      break;
    }

    default:
      console.error(
        `Unknown service command: ${sub ?? "(none)"}\n` +
          `Usage: isotopes service install|uninstall|restart|status`,
      );
      process.exit(1);
  }
}
