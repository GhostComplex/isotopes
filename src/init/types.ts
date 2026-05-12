export type Provider =
  | { type: "ghc-proxy"; baseUrl: string; apiKey: string; model: string }
  | { type: "minimax-cn"; apiKey: string; model: string }
  | { type: "skip" };

export type DmPolicyChoice = "disabled" | "allowlist";
export type GroupPolicyChoice = "disabled" | "allowlist" | "open";

export type Channel =
  | {
      type: "discord";
      token: string;
      dmPolicy: DmPolicyChoice;
      dmUserId?: string;
      groupPolicy: GroupPolicyChoice;
      groupAllowlist?: string[];
    }
  | { type: "skip" };

export type CodingAgentChoice = "claude" | "skip";

export interface InitAnswers {
  provider: Provider;
  channel: Channel;
  codingAgent: CodingAgentChoice;
}
