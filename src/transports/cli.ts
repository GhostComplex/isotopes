// src/transports/cli.ts — CLI transport with simulated reply & reaction support

import type { Transport } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("transport:cli");

/**
 * CliTransport — a minimal transport for local/testing use.
 *
 * Implements reply() and react() by printing simulated output to the console
 * rather than sending to an external service.
 */
export class CliTransport implements Transport {
  private started = false;

  async start(): Promise<void> {
    this.started = true;
    log.info("CLI transport started");
  }

  async stop(): Promise<void> {
    this.started = false;
    log.info("CLI transport stopped");
  }

  async reply(messageId: string, content: string): Promise<{ messageId: string }> {
    if (!this.started) throw new Error("CLI transport not started");
    const replyId = `cli-reply-${Date.now()}`;
    log.info(`[Reply to ${messageId}] ${content}`);
    return { messageId: replyId };
  }

  async react(messageId: string, emoji: string): Promise<void> {
    if (!this.started) throw new Error("CLI transport not started");
    log.info(`[React to ${messageId}] ${emoji}`);
  }
}
