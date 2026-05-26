import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "./logger.js";

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
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[test]"));
    });

    it("includes timestamp", () => {
      const log = createLogger("test");
      log.info("Hello");
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T/));
    });

    it("includes level", () => {
      const log = createLogger("test");
      log.warn("Warning!");
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[WARN ]"));
    });

    it("passes extra args to console", () => {
      const log = createLogger("test");
      const obj = { foo: "bar" };
      log.info("Message", obj);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Message"), obj);
    });
  });

  describe("log levels", () => {
    it("filters debug at default info level", () => {
      const log = createLogger("test");
      log.debug("hidden");
      expect(console.debug).not.toHaveBeenCalled();
    });

    it("passes info/warn/error at default level", () => {
      const log = createLogger("test");
      log.info("i");
      log.warn("w");
      log.error("e");
      expect(console.log).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });

    it("respects LOG_LEVEL changes at runtime", () => {
      vi.stubEnv("LOG_LEVEL", "info");
      const log = createLogger("test");

      log.debug("hidden");
      expect(console.debug).not.toHaveBeenCalled();

      vi.stubEnv("LOG_LEVEL", "debug");
      log.debug("visible");
      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("visible"));
    });
  });

  describe("child loggers", () => {
    it("creates child logger with combined tag", () => {
      const child = createLogger("parent").child("child");
      child.info("Hello");
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[parent:child]"));
    });
  });
});
