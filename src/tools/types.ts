// src/tools/types.ts — Per-agent tool settings (allow/deny + feature toggles)

export interface AgentToolSettings {
  web?: boolean;
  allow?: string[];
  deny?: string[];
}
