// src/tools/types.ts — Per-agent tool settings (allow/deny filters)

export interface AgentToolSettings {
  allow?: string[];
  deny?: string[];
  /** Per-tool config; currently only the `message` tool's allowlist. */
  message?: { allowedChannels?: string[] };
}
