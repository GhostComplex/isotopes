// src/daemon/index.ts — Barrel exports for daemon module

export { DaemonProcess } from "./process.js";
export type { DaemonStatus, DaemonOptions } from "./process.js";

export { ServiceManager, getPlatform } from "./service.js";
export type { ServiceConfig, ServicePlatform } from "./service.js";

export { LogRotator } from "./log-rotation.js";
export type { LogRotationConfig } from "./log-rotation.js";
