// src/core/logger.test.ts — Unit tests for logger

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, logger, loggers } from "./logger.js";

describe("Logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("createLogger", () => {
    it("creates a logger with tag", () => {
      const log = createLogger("test");

      log.info("Hello");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("[test]"),
        // no extra args
      );
    });

    it("includes timestamp", () => {
      const log = createLogger("test");

      log.info("Hello");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T/),
      );
    });

    it("includes level", () => {
      const log = createLogger("test");

      log.warn("Warning!");

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("[WARN ]"),
      );
    });
  });

  describe("log levels", () => {
    it("logs info by default", () => {
      const log = createLogger("test");

      log.info("Info message");

      expect(console.log).toHaveBeenCalled();
    });

    it("logs warn by default", () => {
      const log = createLogger("test");

      log.warn("Warn message");

      expect(console.warn).toHaveBeenCalled();
    });

    it("logs error by default", () => {
      const log = createLogger("test");

      log.error("Error message");

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("child loggers", () => {
    it("creates child logger with combined tag", () => {
      const parent = createLogger("parent");
      const child = parent.child("child");

      child.info("Hello");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("[parent:child]"),
      );
    });
  });

  describe("pre-configured loggers", () => {
    it("exports named loggers", () => {
      expect(loggers.core).toBeDefined();
      expect(loggers.discord).toBeDefined();
      expect(loggers.agent).toBeDefined();
      expect(loggers.session).toBeDefined();
      expect(loggers.tools).toBeDefined();
      expect(loggers.config).toBeDefined();
    });
  });

  describe("default logger", () => {
    it("has isotopes tag", () => {
      logger.info("Test");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("[isotopes]"),
      );
    });
  });

  describe("extra arguments", () => {
    it("passes extra args to console", () => {
      const log = createLogger("test");
      const obj = { foo: "bar" };

      log.info("Message", obj);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Message"),
        obj,
      );
    });
  });

  describe("dynamic log level", () => {
    it("respects LOG_LEVEL changes at runtime", () => {
      // Start with info level
      vi.stubEnv("LOG_LEVEL", "info");
      const log = createLogger("dynamic");

      // debug should be filtered at info level
      log.debug("should not appear");
      expect(console.debug).not.toHaveBeenCalled();

      // Change to debug level
      vi.stubEnv("LOG_LEVEL", "debug");

      // Now debug should appear (same logger instance)
      log.debug("should appear");
      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining("should appear"),
      );
    });

    it("respects LOG_LEVEL changes for filtering", () => {
      // Start with debug level
      vi.stubEnv("LOG_LEVEL", "debug");
      const log = createLogger("dynamic");

      log.info("info at debug level");
      expect(console.log).toHaveBeenCalled();

      vi.mocked(console.log).mockClear();

      // Raise to error level
      vi.stubEnv("LOG_LEVEL", "error");

      // info should now be filtered
      log.info("info at error level");
      expect(console.log).not.toHaveBeenCalled();
    });
  });
});
