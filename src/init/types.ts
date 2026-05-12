// Shared answer types for the init wizard.
// Kept separate from wizard.tsx (UI) and render.ts (pure rendering) so both
// sides depend on a neutral home rather than each other.

export type Provider =
  | { type: "ghc-proxy"; baseUrl: string; apiKey: string; model: string }
  | { type: "skip" };

export type ChannelChoice = "discord" | "skip";
export type CodingAgentChoice = "claude" | "skip";

export type DmPolicyChoice = "disabled" | "allowlist";
export type GroupPolicyChoice = "disabled" | "allowlist" | "open";

export interface DiscordAnswers {
  token: string;
  dmPolicy: DmPolicyChoice;
  dmUserId?: string;
  groupPolicy: GroupPolicyChoice;
  groupAllowlist?: string[];
}

export interface InitAnswers {
  provider: Provider;
  channel: ChannelChoice;
  discord?: DiscordAnswers;
  codingAgent: CodingAgentChoice;
}
