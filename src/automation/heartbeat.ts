// src/automation/heartbeat.ts — Heartbeat system for periodic agent wake-ups
// Reads HEARTBEAT.md from workspace and prompts the agent on a timer.
// Silent replies (NO_REPLY / HEARTBEAT_OK) are suppressed; other output is logged.

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger, type Logger } from "../core/logger.js";
import { isSilentReply } from "../transports/silent-reply.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for an agent's heartbeat. */
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
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_SECONDS = 300;
const HEARTBEAT_FILE = "HEARTBEAT.md";

// ---------------------------------------------------------------------------
// HeartbeatManager
// ---------------------------------------------------------------------------

/**
 * HeartbeatManager — triggers periodic agent wake-ups.
 *
 * On each interval tick the manager reads `HEARTBEAT.md` from the agent's
 * workspace, builds a prompt with the file contents and current timestamp,
 * and calls the supplied `runAgentLoop` callback. If the agent responds with
 * a silent-reply token the output is suppressed; otherwise it is logged.
 *
 * A concurrency guard ensures that if a heartbeat is still running when the
 * next interval fires, the tick is skipped rather than stacking prompts.
 */
export class HeartbeatManager {
  private readonly agentId: string;
  private readonly workspacePath: string;
  private readonly intervalMs: number;
  private readonly runAgentLoop: RunAgentLoop;
  private readonly log: Logger;

  private timer: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;

  constructor(options: HeartbeatManagerOptions) {
    this.agentId = options.agentId;
    this.workspacePath = options.workspacePath;
    this.intervalMs = (options.config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
    this.runAgentLoop = options.runAgentLoop;
    this.log = options.logger ?? createLogger(`heartbeat:${options.agentId}`);
  }

  /** Start the heartbeat interval timer. */
  start(): void {
    if (this.timer) return; // already started

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Don't keep the process alive solely for heartbeats
    if (this.timer.unref) this.timer.unref();

    this.log.info(
      `Heartbeat started for "${this.agentId}" (every ${this.intervalMs / 1000}s)`,
    );
  }

  /** Stop the heartbeat interval timer. */
  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = undefined;

    this.log.info(`Heartbeat stopped for "${this.agentId}"`);
  }

  /** Manually trigger a single heartbeat. Useful for testing. */
  async trigger(): Promise<void> {
    await this.tick();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    // Concurrency guard — skip if previous heartbeat is still running
    if (this.isRunning) {
      this.log.debug(`Heartbeat skipped for "${this.agentId}" (previous still running)`);
      return;
    }

    // Read HEARTBEAT.md — no-op with debug log if missing
    const heartbeatPath = path.join(this.workspacePath, HEARTBEAT_FILE);
    let content: string;
    try {
      content = await fs.readFile(heartbeatPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.log.debug(`No HEARTBEAT.md found for "${this.agentId}" — skipping`);
        return;
      }
      this.log.error(`Failed to read HEARTBEAT.md for "${this.agentId}":`, err);
      return;
    }

    const sessionKey = `heartbeat:${this.agentId}`;
    const prompt = buildHeartbeatPrompt(content);

    this.isRunning = true;
    this.log.info(`Heartbeat triggered for "${this.agentId}"`);

    try {
      const response = await this.runAgentLoop(this.agentId, prompt, sessionKey);

      if (isSilentReply(response)) {
        this.log.debug(`Heartbeat silent reply from "${this.agentId}"`);
      } else {
        this.log.info(`Heartbeat response from "${this.agentId}": ${response}`);
      }
    } catch (err) {
      this.log.error(`Heartbeat error for "${this.agentId}":`, err);
    } finally {
      this.isRunning = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildHeartbeatPrompt(heartbeatContent: string): string {
  const timestamp = new Date().toISOString();
  return `[HEARTBEAT]

The current time is ${timestamp}.

Your HEARTBEAT.md file says:
---
${heartbeatContent.trim()}
---

Review your scheduled tasks and decide if any action is needed.
If nothing to do, respond with only: NO_REPLY`;
}
