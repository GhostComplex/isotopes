// src/sandbox/config.test.ts — Unit tests for sandbox config resolution

import { describe, it, expect } from "vitest";
import { resolveSandboxConfig } from "./sandbox-config.js";
import type { SandboxConfig } from "./sandbox-config.js";

describe("Sandbox Config", () => {
  describe("resolveSandboxConfig", () => {
    it("returns enabled=false when no config provided", () => {
      const config = resolveSandboxConfig("test-agent");
      expect(config.enabled).toBe(false);
    });

    it("uses defaults when no override provided", () => {
      const defaults: SandboxConfig = {
        enabled: true,
        workspaceAccess: "rw",
        docker: { image: "custom:latest", network: "bridge" },
      };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.enabled).toBe(true);
      expect(config.workspaceAccess).toBe("rw");
      expect(config.docker?.image).toBe("custom:latest");
      expect(config.docker?.network).toBe("bridge");
    });

    it("override takes precedence over defaults", () => {
      const defaults: SandboxConfig = {
        enabled: true,
        workspaceAccess: "rw",
        docker: { image: "default:latest", network: "bridge" },
      };
      const override: SandboxConfig = {
        enabled: false,
        workspaceAccess: "ro",
      };

      const config = resolveSandboxConfig("test-agent", defaults, override);

      expect(config.enabled).toBe(false);
      expect(config.workspaceAccess).toBe("ro");
    });

    it("merges docker config — override image, keep default network", () => {
      const defaults: SandboxConfig = {
        enabled: true,
        docker: { image: "default:latest", network: "host" },
      };
      const override: SandboxConfig = {
        enabled: true,
        docker: { image: "custom:v2" },
      };

      const config = resolveSandboxConfig("test-agent", defaults, override);

      expect(config.docker?.image).toBe("custom:v2");
      expect(config.docker?.network).toBe("host");
    });

    it("provides default docker config when none specified", () => {
      const defaults: SandboxConfig = { enabled: true };
      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.docker?.image).toBe("isotopes-sandbox:latest");
      expect(config.docker?.network).toBe("bridge");
    });

    it("preserves resource limits from defaults", () => {
      const defaults: SandboxConfig = {
        enabled: true,
        docker: { image: "test:latest", cpuLimit: 2, memoryLimit: "1g" },
      };

      const config = resolveSandboxConfig("test-agent", defaults);

      expect(config.docker?.cpuLimit).toBe(2);
      expect(config.docker?.memoryLimit).toBe("1g");
    });

    it("override resource limits take precedence", () => {
      const defaults: SandboxConfig = {
        enabled: true,
        docker: { image: "test:latest", cpuLimit: 2, memoryLimit: "1g" },
      };
      const override: SandboxConfig = {
        enabled: true,
        docker: { image: "test:latest", cpuLimit: 0.5, memoryLimit: "256m" },
      };

      const config = resolveSandboxConfig("test-agent", defaults, override);

      expect(config.docker?.cpuLimit).toBe(0.5);
      expect(config.docker?.memoryLimit).toBe("256m");
    });

    it("preserves extraHosts from defaults", () => {
      const defaults: SandboxConfig = {
        enabled: true,
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
      const config = resolveSandboxConfig("test-agent", { enabled: true });
      expect(config.workspaceAccess).toBe("rw");
    });

    it("throws on invalid workspaceAccess", () => {
      const bad: SandboxConfig = {
        enabled: true,
        workspaceAccess: "exec" as "rw",
      };

      expect(() => resolveSandboxConfig("test-agent", undefined, bad)).toThrow(
        'invalid workspaceAccess "exec"',
      );
    });

    it("throws on empty docker image", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", { enabled: true, docker: { image: "" } }),
      ).toThrow("docker.image is required");
    });

    it("throws on invalid network mode", () => {
      const bad: SandboxConfig = {
        enabled: true,
        docker: { image: "test:latest", network: "overlay" as "bridge" },
      };

      expect(() => resolveSandboxConfig("test-agent", bad)).toThrow(
        'invalid docker.network "overlay"',
      );
    });

    it("throws on non-positive cpuLimit", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          enabled: true,
          docker: { image: "test:latest", cpuLimit: -1 },
        }),
      ).toThrow("docker.cpuLimit must be a positive number");
    });

    it("throws on invalid memoryLimit format", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          enabled: true,
          docker: { image: "test:latest", memoryLimit: "500mb" },
        }),
      ).toThrow("docker.memoryLimit must match pattern");
    });

    it("accepts valid memoryLimit formats", () => {
      for (const memoryLimit of ["512k", "512m", "1g", "2G", "100M"]) {
        const config = resolveSandboxConfig("test-agent", {
          enabled: true,
          docker: { image: "test:latest", memoryLimit },
        });
        expect(config.docker?.memoryLimit).toBe(memoryLimit);
      }
    });

    it("applies hardening defaults when docker is provided without overrides", () => {
      const cfg = resolveSandboxConfig("test-agent", {
        enabled: true,
        docker: { image: "test:latest" },
      });
      expect(cfg.docker?.pidsLimit).toBe(256);
      expect(cfg.docker?.noNewPrivileges).toBe(true);
    });

    it("preserves explicit hardening overrides", () => {
      const cfg = resolveSandboxConfig("test-agent", {
        enabled: true,
        docker: {
          image: "test:latest",
          pidsLimit: 0,
          noNewPrivileges: false,
        },
      });
      expect(cfg.docker?.pidsLimit).toBe(0);
      expect(cfg.docker?.noNewPrivileges).toBe(false);
    });

    it("throws when base + agent mounts produce duplicate container paths", () => {
      expect(() =>
        resolveSandboxConfig(
          "test-agent",
          { enabled: true, mounts: [{ host: "/a", container: "/foo" }] },
          { enabled: true, mounts: [{ host: "/b", container: "/foo" }] },
        ),
      ).toThrow(/mounts\[1\]\.container "\/foo" duplicates/);
    });

    it("throws on negative pidsLimit", () => {
      expect(() =>
        resolveSandboxConfig("test-agent", {
          enabled: true,
          docker: { image: "test:latest", pidsLimit: -1 },
        }),
      ).toThrow("docker.pidsLimit must be a non-negative integer");
    });
  });
});
