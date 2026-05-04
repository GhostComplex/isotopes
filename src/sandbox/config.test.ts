// src/sandbox/config.test.ts — Unit tests for sandbox config resolution

import { describe, it, expect } from "vitest";
import {
  resolveSandboxConfig,
  shouldSandbox,
} from "./config.js";
import type { SandboxConfig } from "./config.js";

describe("Sandbox Config", () => {
  describe("resolveSandboxConfig", () => {
    it("returns mode 'off' when no config provided", () => {
      const config = resolveSandboxConfig("test-agent");

      expect(config.mode).toBe("off");
    });

    it("uses defaults when no override provided", () => {
      const defaults: SandboxConfig = {
        mode: "non-main",
        workspaceAccess: "rw",
        docker: { image: "custom:latest", network: "bridge" },
      };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.mode).toBe("non-main");
      expect(config.workspaceAccess).toBe("rw");
      expect(config.docker?.image).toBe("custom:latest");
      expect(config.docker?.network).toBe("bridge");
    });

    it("override takes precedence over defaults", () => {
      const defaults: SandboxConfig = {
        mode: "non-main",
        workspaceAccess: "rw",
        docker: { image: "default:latest", network: "bridge" },
      };
      const override: SandboxConfig = {
        mode: "off",
        workspaceAccess: "ro",
      };

      const config = resolveSandboxConfig("test-agent", defaults, override);

      expect(config.mode).toBe("off");
      expect(config.workspaceAccess).toBe("ro");
    });

    it("merges docker config — override image, keep default network", () => {
      const defaults: SandboxConfig = {
        mode: "all",
        docker: { image: "default:latest", network: "host" },
      };
      const override: SandboxConfig = {
        mode: "all",
        docker: { image: "custom:v2" },
      };

      const config = resolveSandboxConfig("test-agent", defaults, override);

      expect(config.docker?.image).toBe("custom:v2");
      expect(config.docker?.network).toBe("host");
    });

    it("provides default docker config when none specified", () => {
      const defaults: SandboxConfig = { mode: "all" };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.docker?.image).toBe("isotopes-sandbox:latest");
      expect(config.docker?.network).toBe("bridge");
    });

    it("preserves resource limits from defaults", () => {
      const defaults: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", cpuLimit: 2, memoryLimit: "1g" },
      };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.docker?.cpuLimit).toBe(2);
      expect(config.docker?.memoryLimit).toBe("1g");
    });

    it("override resource limits take precedence", () => {
      const defaults: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", cpuLimit: 2, memoryLimit: "1g" },
      };
      const override: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", cpuLimit: 0.5, memoryLimit: "256m" },
      };

      const config = resolveSandboxConfig("test-agent", defaults, override);

      expect(config.docker?.cpuLimit).toBe(0.5);
      expect(config.docker?.memoryLimit).toBe("256m");
    });

    it("preserves extraHosts from defaults", () => {
      const defaults: SandboxConfig = {
        mode: "all",
        docker: {
          image: "test:latest",
          extraHosts: ["host.docker.internal:host-gateway"],
        },
      };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.docker?.extraHosts).toEqual([
        "host.docker.internal:host-gateway",
      ]);
    });

    it("defaults workspaceAccess to 'rw'", () => {
      const defaults: SandboxConfig = { mode: "all" };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.workspaceAccess).toBe("rw");
    });

    // ---- Validation tests ----

    it("throws on invalid sandbox mode", () => {
      const bad = { mode: "invalid" as "off" };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        'invalid sandbox mode "invalid"',
      );
    });

    it("throws on invalid workspaceAccess", () => {
      const bad: SandboxConfig = {
        mode: "all",
        workspaceAccess: "exec" as "rw",
      };

      expect(() => resolveSandboxConfig("test-agent", undefined, bad)).toThrow(
        'invalid workspaceAccess "exec"',
      );
    });

    it("throws on empty docker image", () => {
      const bad: SandboxConfig = {
        mode: "all",
        docker: { image: "" },
      };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        "docker.image is required",
      );
    });

    it("throws on invalid network mode", () => {
      const bad: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", network: "overlay" as "bridge" },
      };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        'invalid docker.network "overlay"',
      );
    });

    it("throws on non-positive cpuLimit", () => {
      const bad: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", cpuLimit: -1 },
      };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        "docker.cpuLimit must be a positive number",
      );
    });

    it("throws on zero cpuLimit", () => {
      const bad: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", cpuLimit: 0 },
      };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        "docker.cpuLimit must be a positive number",
      );
    });

    it("throws on invalid memoryLimit format", () => {
      const bad: SandboxConfig = {
        mode: "all",
        docker: { image: "test:latest", memoryLimit: "500mb" },
      };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        "docker.memoryLimit must match pattern",
      );
    });

    it("accepts valid memoryLimit formats", () => {
      for (const memoryLimit of ["512k", "512m", "1g", "2G", "100M"]) {
        const config = resolveSandboxConfig("test-agent", {
          mode: "all",
          docker: { image: "test:latest", memoryLimit },
        });
        expect(config.docker?.memoryLimit).toBe(memoryLimit);
      }
    });

    it("applies hardening defaults when docker is provided without overrides", () => {
      const cfg = resolveSandboxConfig("test-agent", {
        mode: "all",
        docker: { image: "test:latest" },
      });
      expect(cfg.docker?.pidsLimit).toBe(256);
      expect(cfg.docker?.capDrop).toEqual(["ALL"]);
      expect(cfg.docker?.capAdd).toEqual([]);
      expect(cfg.docker?.noNewPrivileges).toBe(true);
    });

    it("preserves explicit hardening overrides", () => {
      const cfg = resolveSandboxConfig("test-agent", {
        mode: "all",
        docker: {
          image: "test:latest",
          pidsLimit: 0,
          capDrop: [],
          capAdd: ["NET_ADMIN"],
          noNewPrivileges: false,
        },
      });
      expect(cfg.docker?.pidsLimit).toBe(0);
      expect(cfg.docker?.capDrop).toEqual([]);
      expect(cfg.docker?.capAdd).toEqual(["NET_ADMIN"]);
      expect(cfg.docker?.noNewPrivileges).toBe(false);
    });

    it("throws on negative pidsLimit", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          mode: "all",
          docker: { image: "test:latest", pidsLimit: -1 },
        }),
      ).toThrow("docker.pidsLimit must be a non-negative integer");
    });

    it("throws on non-integer pidsLimit", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          mode: "all",
          docker: { image: "test:latest", pidsLimit: 1.5 },
        }),
      ).toThrow("docker.pidsLimit must be a non-negative integer");
    });

    it("throws on non-array capDrop", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          mode: "all",
          docker: { image: "test:latest", capDrop: "ALL" as unknown as string[] },
        }),
      ).toThrow("docker.capDrop must be an array");
    });

    it("throws on non-boolean noNewPrivileges", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          mode: "all",
          docker: { image: "test:latest", noNewPrivileges: "yes" as unknown as boolean },
        }),
      ).toThrow("docker.noNewPrivileges must be a boolean");
    });
  });

  describe("shouldSandbox", () => {
    it("returns false for mode 'off' regardless of isMainAgent", () => {
      const config: SandboxConfig = { mode: "off" };

      expect(shouldSandbox(config, true)).toBe(false);
      expect(shouldSandbox(config, false)).toBe(false);
    });

    it("returns false for mode 'non-main' when isMainAgent is true", () => {
      const config: SandboxConfig = { mode: "non-main" };

      expect(shouldSandbox(config, true)).toBe(false);
    });

    it("returns true for mode 'non-main' when isMainAgent is false", () => {
      const config: SandboxConfig = { mode: "non-main" };

      expect(shouldSandbox(config, false)).toBe(true);
    });

    it("returns true for mode 'all' regardless of isMainAgent", () => {
      const config: SandboxConfig = { mode: "all" };

      expect(shouldSandbox(config, true)).toBe(true);
      expect(shouldSandbox(config, false)).toBe(true);
    });
  });
});
