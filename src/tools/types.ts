// src/tools/types.ts — Generic tool contract (no business logic)

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolSettings {
  web?: boolean;
  allow?: string[];
  deny?: string[];
}
