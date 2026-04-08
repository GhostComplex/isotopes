// src/sandbox/config.ts — Sandbox configuration for secure tool execution
// Defines types and resolution logic for Docker-based sandbox execution.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sandbox execution mode */
export type SandboxMode = "off" | "non-main" | "all";

/** Workspace mount access level */
export type WorkspaceAccess = "rw" | "ro";

/** Docker container configuration */
export interface DockerConfig {
  /** Docker image to use for sandbox containers */
  image: string;
  /** Docker network mode */
  network?: "bridge" | "host" | "none";
  /** Extra /etc/hosts entries (e.g., "host.docker.internal:host-gateway") */
  extraHosts?: string[];
  /** CPU core limit (e.g., 1.5 = 1.5 cores) */
  cpuLimit?: number;
  /** Memory limit (e.g., "512m", "1g") */
  memoryLimit?: string;
}

/** Sandbox configuration for an agent */
export interface SandboxConfig {
  /** Sandbox execution mode */
  mode: SandboxMode;
  /** Workspace mount access level. Default: "rw" */
  workspaceAccess?: WorkspaceAccess;
  /** Docker configuration */
  docker?: DockerConfig;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_SANDBOX_MODES = new Set<string>(["off", "non-main", "all"]);
const VALID_WORKSPACE_ACCESS = new Set<string>(["rw", "ro"]);
const VALID_NETWORK_MODES = new Set<string>(["bridge", "host", "none"]);
const MEMORY_LIMIT_PATTERN = /^\d+[kmg]$/i;

/**
 * Validate a SandboxConfig, throwing on invalid values.
 */
function validateSandboxConfig(config: SandboxConfig, label: string): void {
  if (!VALID_SANDBOX_MODES.has(config.mode)) {
    throw new Error(
      `${label}: invalid sandbox mode "${config.mode}" (must be off, non-main, or all)`,
    );
  }

  if (config.workspaceAccess !== undefined && !VALID_WORKSPACE_ACCESS.has(config.workspaceAccess)) {
    throw new Error(
      `${label}: invalid workspaceAccess "${config.workspaceAccess}" (must be rw or ro)`,
    );
  }

  if (config.docker) {
    if (!config.docker.image || typeof config.docker.image !== "string") {
      throw new Error(`${label}: docker.image is required and must be a non-empty string`);
    }

    if (config.docker.network !== undefined && !VALID_NETWORK_MODES.has(config.docker.network)) {
      throw new Error(
        `${label}: invalid docker.network "${config.docker.network}" (must be bridge, host, or none)`,
      );
    }

    if (config.docker.cpuLimit !== undefined) {
      if (typeof config.docker.cpuLimit !== "number" || config.docker.cpuLimit <= 0) {
        throw new Error(
          `${label}: docker.cpuLimit must be a positive number`,
        );
      }
    }

    if (config.docker.memoryLimit !== undefined) {
      if (typeof config.docker.memoryLimit !== "string" || !MEMORY_LIMIT_PATTERN.test(config.docker.memoryLimit)) {
        throw new Error(
          `${label}: docker.memoryLimit must match pattern like "512m", "1g" (digits followed by k, m, or g)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Default Docker configuration */
const DEFAULT_DOCKER_CONFIG: DockerConfig = {
  image: "isotopes-sandbox:latest",
  network: "bridge",
};

/**
 * Resolve sandbox config for a specific agent by merging agent-level overrides
 * with defaults. Agent-level values take precedence over defaults.
 *
 * @param agentId - The agent identifier (used in error messages)
 * @param defaults - Default sandbox config (from agents.defaults.sandbox)
 * @param override - Agent-level sandbox config override
 * @returns Resolved SandboxConfig
 */
export function resolveSandboxConfig(
  agentId: string,
  defaults?: SandboxConfig,
  override?: SandboxConfig,
): SandboxConfig {
  // No sandbox config at all → mode: off
  if (!defaults && !override) {
    return { mode: "off" };
  }

  const resolved: SandboxConfig = {
    mode: override?.mode ?? defaults?.mode ?? "off",
    workspaceAccess: override?.workspaceAccess ?? defaults?.workspaceAccess ?? "rw",
    docker: mergeDockerConfig(defaults?.docker, override?.docker),
  };

  validateSandboxConfig(resolved, `agent "${agentId}"`);

  return resolved;
}

/**
 * Merge Docker configs, with override values taking precedence.
 */
function mergeDockerConfig(
  defaults?: DockerConfig,
  override?: DockerConfig,
): DockerConfig {
  if (!defaults && !override) return { ...DEFAULT_DOCKER_CONFIG };

  return {
    image: override?.image ?? defaults?.image ?? DEFAULT_DOCKER_CONFIG.image,
    network: override?.network ?? defaults?.network ?? DEFAULT_DOCKER_CONFIG.network,
    extraHosts: override?.extraHosts ?? defaults?.extraHosts,
    cpuLimit: override?.cpuLimit ?? defaults?.cpuLimit,
    memoryLimit: override?.memoryLimit ?? defaults?.memoryLimit,
  };
}

/**
 * Determine whether an agent should be sandboxed based on the config and
 * whether it is the "main" agent.
 *
 * - mode "off"      → never sandbox
 * - mode "non-main" → sandbox only if NOT the main agent
 * - mode "all"      → always sandbox
 *
 * @param config - Resolved sandbox config
 * @param isMainAgent - Whether this agent is the main/primary agent
 * @returns true if the agent should run in a sandbox
 */
export function shouldSandbox(config: SandboxConfig, isMainAgent: boolean): boolean {
  switch (config.mode) {
    case "off":
      return false;
    case "non-main":
      return !isMainAgent;
    case "all":
      return true;
    default:
      return false;
  }
}
