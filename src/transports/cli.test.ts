// src/transports/cli.test.ts — Unit tests for CliTransport

import { describe, it, expect, beforeEach } from "vitest";
import { CliTransport } from "./cli.js";

describe("CliTransport", () => {
  let transport: CliTransport;

  beforeEach(() => {
    transport = new CliTransport();
  });

  describe("start/stop", () => {
    it("starts and stops without error", async () => {
      await transport.start();
      await transport.stop();
    });
  });

  describe("reply", () => {
    it("returns a reply message ID", async () => {
      await transport.start();
      const result = await transport.reply("msg-123", "Hello back!");
      expect(result.messageId).toMatch(/^cli-reply-\d+$/);
    });

    it("throws when transport is not started", async () => {
      await expect(transport.reply("msg-123", "Hello")).rejects.toThrow(
        "CLI transport not started",
      );
    });
  });

  describe("react", () => {
    it("completes without error", async () => {
      await transport.start();
      await expect(transport.react("msg-123", "👍")).resolves.toBeUndefined();
    });

    it("throws when transport is not started", async () => {
      await expect(transport.react("msg-123", "👍")).rejects.toThrow(
        "CLI transport not started",
      );
    });
  });
});
