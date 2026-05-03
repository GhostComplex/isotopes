// src/sandbox/index.ts — Barrel exports for sandbox module

export type {
  SandboxMode,
  WorkspaceAccess,
  DockerConfig,
  SandboxConfig,
} from "./config.js";

export {
  resolveSandboxConfig,
  shouldSandbox,
} from "./config.js";

export type {
  ContainerStatus,
  ContainerInfo,
  ExecResult,
} from "./container.js";

export { ContainerManager } from "./container.js";

export type { SandboxExecOptions } from "./executor.js";

export { SandboxExecutor } from "./executor.js";

export type { FsErrorCode, FsBridge } from "./fs-bridge.js";

export { SandboxFs, HostFs, FsError, mapStderrToCode } from "./fs-bridge.js";
