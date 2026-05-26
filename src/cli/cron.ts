import { apiFetch, ApiError } from "../utils/api-client.js";
import { requireArg } from "./helpers.js";

type CronJob = {
  id: string;
  schedule: string;
  agentId: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
};

export async function handleCronCommand(positionals: string[], json: boolean): Promise<void> {
  const subCmd = positionals[0];

  try {
    switch (subCmd) {
      case "list":
      case undefined: {
        const jobs = await apiFetch<CronJob[]>("GET", "/api/cron");
        if (json) {
          console.log(JSON.stringify(jobs, null, 2));
        } else if (jobs.length === 0) {
            console.log("No cron jobs configured");
        } else {
          console.log(`Cron Jobs (${jobs.length}):\n`);
          for (const j of jobs) {
            console.log(`  ${j.id} [${j.enabled ? "enabled" : "disabled"}]`);
            console.log(`    Schedule: ${j.schedule}`);
            console.log(`    Agent: ${j.agentId}`);
            if (j.lastRun) console.log(`    Last run: ${j.lastRun}`);
            if (j.nextRun) console.log(`    Next run: ${j.nextRun}`);
            console.log();
          }
        }
        break;
      }
      case "add": {
        const schedule = positionals[1];
        const task = positionals.slice(2).join(" ");
        if (!schedule || !task) {
          console.error("Usage: isotopes cron add <schedule> <task>");
          console.error('Example: isotopes cron add "0 9 * * *" "Send daily summary"');
          process.exit(1);
        }
        const job = await apiFetch<{ id: string }>("POST", "/api/cron", { schedule, task });
        console.log(`Cron job created: ${job.id}`);
        break;
      }
      case "remove":
      case "enable":
      case "disable":
      case "run": {
        const id = requireArg(positionals[1], `isotopes cron ${subCmd} <id>`);
        const spec = {
          remove: { method: "DELETE" as const, path: `/api/cron/${id}`, success: `Cron job removed: ${id}` },
          enable: { method: "POST" as const, path: `/api/cron/${id}/enable`, success: `Cron job enabled: ${id}` },
          disable: { method: "POST" as const, path: `/api/cron/${id}/disable`, success: `Cron job disabled: ${id}` },
          run: { method: "POST" as const, path: `/api/cron/${id}/run`, success: `Cron job triggered: ${id}` },
        }[subCmd];
        try {
          await apiFetch(spec.method, spec.path);
          console.log(spec.success);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            console.error(`Job not found: ${id}`);
            process.exit(1);
          }
          throw err;
        }
        break;
      }
      default:
        console.error(`Unknown cron subcommand: ${subCmd}`);
        console.error("Usage: isotopes cron [list|add|remove|enable|disable|run] [args]");
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof TypeError && String(err).includes("fetch")) {
      console.error("Cannot connect to daemon. Is it running? Run `isotopes` in the foreground or via the LaunchAgent.");
    } else {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}
