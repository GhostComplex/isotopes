import fs from "node:fs/promises";
import path from "node:path";

export interface HeartbeatConfig {
  enabled: boolean;
  /** Interval in seconds between heartbeat triggers. Default: 300 (5 min) */
  intervalSeconds?: number;
}

/** Function that runs the agent loop and returns the full response text. */
export type RunAgentLoop = (agentId: string, prompt: string, sessionKey: string) => Promise<string>;

export interface HeartbeatManagerOptions {
  agentId: string;
  workspacePath: string;
  config: HeartbeatConfig;
  runAgentLoop: RunAgentLoop;
}

const DEFAULT_INTERVAL_SECONDS = 300;
const HEARTBEAT_FILE = "HEARTBEAT.md";

/**
 * Periodically wakes an agent by reading its HEARTBEAT.md and dispatching it
 * as a prompt. Overlapping ticks are skipped, not stacked.
 */
export class HeartbeatManager {
  private readonly agentId: string;
  private readonly workspacePath: string;
  private readonly intervalMs: number;
  private readonly runAgentLoop: RunAgentLoop;

  private timer: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;

  constructor(options: HeartbeatManagerOptions) {
    this.agentId = options.agentId;
    this.workspacePath = options.workspacePath;
    this.intervalMs = (options.config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
    this.runAgentLoop = options.runAgentLoop;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Don't keep the process alive solely for heartbeats.
    if (this.timer.unref) this.timer.unref();

  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = undefined;

  }

  /** Manually trigger a single heartbeat. Useful for testing. */
  async trigger(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    const heartbeatPath = path.join(this.workspacePath, HEARTBEAT_FILE);
    let content: string;
    try {
      content = await fs.readFile(heartbeatPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      // non-ENOENT error — skip this tick
      return;
    }

    const sessionKey = `heartbeat:${this.agentId}`;
    const prompt = buildHeartbeatPrompt(content);

    this.isRunning = true;

    try {
      // Cap at 2× interval so a hung run doesn't pin isRunning forever.
      // The run itself isn't canceled — gateway's steer absorbs the next tick.
      const timeoutMs = this.intervalMs * 2;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.runAgentLoop(this.agentId, prompt, sessionKey),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new HeartbeatTimeoutError(timeoutMs)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch { /* ignore */ } finally {
      this.isRunning = false;
    }
  }
}

class HeartbeatTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`heartbeat timed out after ${timeoutMs}ms`);
    this.name = "HeartbeatTimeoutError";
  }
}

function buildHeartbeatPrompt(heartbeatContent: string): string {
  const timestamp = new Date().toISOString();
  return `[HEARTBEAT]

The current time is ${timestamp}.

Your HEARTBEAT.md file says:
---
${heartbeatContent.trim()}
---

Review your scheduled tasks and decide if any action is needed.`;
}
