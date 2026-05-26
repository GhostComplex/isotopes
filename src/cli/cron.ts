import { apiFetch, ApiError } from "../utils/api-client.js";

function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return value;
}

type CronJob = {
  id: string;
  schedule: string;
  agentId: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
};

export async function handleCronCommand(positionals: string[]): Promise<void> {
  const subCmd = positionals[0];
  let notFoundId: string | undefined;

  try {
    switch (subCmd) {
      case "list":
      case undefined: {
        const jobs = await apiFetch<CronJob[]>("GET", "/api/cron");
        if (jobs.length === 0) {
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
      case "remove": {
        const id = requireArg(positionals[1], "isotopes cron remove <id>");
        notFoundId = id;
        await apiFetch("DELETE", `/api/cron/${id}`);
        console.log(`Cron job removed: ${id}`);
        break;
      }
      case "enable": {
        const id = requireArg(positionals[1], "isotopes cron enable <id>");
        notFoundId = id;
        await apiFetch("POST", `/api/cron/${id}/enable`);
        console.log(`Cron job enabled: ${id}`);
        break;
      }
      case "disable": {
        const id = requireArg(positionals[1], "isotopes cron disable <id>");
        notFoundId = id;
        await apiFetch("POST", `/api/cron/${id}/disable`);
        console.log(`Cron job disabled: ${id}`);
        break;
      }
      case "run": {
        const id = requireArg(positionals[1], "isotopes cron run <id>");
        notFoundId = id;
        await apiFetch("POST", `/api/cron/${id}/run`);
        console.log(`Cron job triggered: ${id}`);
        break;
      }
      default:
        console.error(`Unknown cron subcommand: ${subCmd}`);
        console.error("Usage: isotopes cron [list|add|remove|enable|disable|run] [args]");
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && notFoundId) {
      console.error(`Job not found: ${notFoundId}`);
    } else if (err instanceof TypeError && String(err).includes("fetch")) {
      console.error("Cannot connect to daemon. Is it running? Run `isotopes` in the foreground or via the LaunchAgent.");
    } else {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}
