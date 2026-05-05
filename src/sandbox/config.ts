// src/sandbox/config.ts — Sandbox configuration types and resolution.

export type WorkspaceAccess = "rw" | "ro";

export interface DockerConfig {
  image: string;
  network?: "bridge" | "host" | "none";
  /** Extra /etc/hosts entries (e.g., "host.docker.internal:host-gateway") */
  extraHosts?: string[];
  /** CPU core limit (e.g., 1.5 = 1.5 cores) */
  cpuLimit?: number;
  /** Memory limit (e.g., "512m", "1g") */
  memoryLimit?: string;
  /** Max PIDs in container. Default: 256. Set to 0 to disable. */
  pidsLimit?: number;
  /** Apply --security-opt=no-new-privileges. Default: true. */
  noNewPrivileges?: boolean;
}

export interface Mount {
  host: string;
  container: string;
  readOnly?: boolean;
}

export interface SandboxConfig {
  enabled: boolean;
  workspaceAccess?: WorkspaceAccess;
  mounts?: Mount[];
  docker?: DockerConfig;
}

const VALID_WORKSPACE_ACCESS = new Set<string>(["rw", "ro"]);
const VALID_NETWORK_MODES = new Set<string>(["bridge", "host", "none"]);
const MEMORY_LIMIT_PATTERN = /^\d+[kmg]$/i;

function validateSandboxConfig(config: SandboxConfig, label: string): void {
  const check = (cond: boolean, msg: string) => { if (!cond) throw new Error(`${label}: ${msg}`); };

  if (config.workspaceAccess !== undefined) {
    check(VALID_WORKSPACE_ACCESS.has(config.workspaceAccess), `invalid workspaceAccess "${config.workspaceAccess}" (must be rw or ro)`);
  }

  if (config.mounts !== undefined) {
    for (let i = 0; i < config.mounts.length; i++) {
      const m = config.mounts[i];
      check(m.host.startsWith("/"), `mounts[${i}].host must be an absolute path`);
      check(m.container.startsWith("/"), `mounts[${i}].container must be an absolute path`);
    }
  }

  if (config.docker) {
    const d = config.docker;
    check(!!d.image, "docker.image is required");
    if (d.network !== undefined) check(VALID_NETWORK_MODES.has(d.network), `invalid docker.network "${d.network}" (must be bridge, host, or none)`);
    if (d.cpuLimit !== undefined) check(d.cpuLimit > 0, "docker.cpuLimit must be a positive number");
    if (d.memoryLimit !== undefined) check(MEMORY_LIMIT_PATTERN.test(d.memoryLimit), `docker.memoryLimit must match pattern like "512m", "1g"`);
    if (d.pidsLimit !== undefined) check(d.pidsLimit >= 0 && Number.isInteger(d.pidsLimit), "docker.pidsLimit must be a non-negative integer");
  }
}

const DEFAULT_DOCKER_CONFIG: DockerConfig = {
  image: "isotopes-sandbox:latest",
  network: "bridge",
  pidsLimit: 256,
  noNewPrivileges: true,
};

/**
 * Merge agent-level overrides over defaults. Returns `{ enabled: false }` when
 * no config is provided at any layer.
 */
export function resolveSandboxConfig(
  agentId: string,
  defaults?: SandboxConfig,
  override?: SandboxConfig,
): SandboxConfig {
  if (!defaults && !override) return { enabled: false };

  const resolved: SandboxConfig = {
    enabled: override?.enabled ?? defaults?.enabled ?? false,
    workspaceAccess: override?.workspaceAccess ?? defaults?.workspaceAccess ?? "rw",
    mounts: override?.mounts ?? defaults?.mounts,
    docker: mergeDockerConfig(defaults?.docker, override?.docker),
  };

  validateSandboxConfig(resolved, `agent "${agentId}"`);
  return resolved;
}

function mergeDockerConfig(defaults?: DockerConfig, override?: DockerConfig): DockerConfig {
  if (!defaults && !override) return { ...DEFAULT_DOCKER_CONFIG };
  return {
    image: override?.image ?? defaults?.image ?? DEFAULT_DOCKER_CONFIG.image,
    network: override?.network ?? defaults?.network ?? DEFAULT_DOCKER_CONFIG.network,
    extraHosts: override?.extraHosts ?? defaults?.extraHosts,
    cpuLimit: override?.cpuLimit ?? defaults?.cpuLimit,
    memoryLimit: override?.memoryLimit ?? defaults?.memoryLimit,
    pidsLimit: override?.pidsLimit ?? defaults?.pidsLimit ?? DEFAULT_DOCKER_CONFIG.pidsLimit,
    noNewPrivileges: override?.noNewPrivileges ?? defaults?.noNewPrivileges ?? DEFAULT_DOCKER_CONFIG.noNewPrivileges,
  };
}

export function shouldSandbox(config: SandboxConfig): boolean {
  return config.enabled;
}
