// src/tools/types.ts — Per-agent tool settings (allow/deny filters)

export interface AgentToolSettings {
  allow?: string[];
  deny?: string[];
  message?: { allowedChannels?: string[] };
}
