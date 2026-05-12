export type Provider =
  | { type: "ghc-proxy"; baseUrl: string; apiKey: string; model: string }
  | { type: "minimax-cn"; apiKey: string; model: string }
  | { type: "skip" };

export type DmPolicy = "disabled" | "allowlist";
export type GroupPolicy = "disabled" | "allowlist" | "open";

export type Channel =
  | {
      type: "discord";
      token: string;
      dmPolicy: DmPolicy;
      dmUserId?: string;
      groupPolicy: GroupPolicy;
      groupAllowlist?: string[];
    }
  | { type: "skip" };

export type CodingAgent = "claude" | "skip";

export interface InitAnswers {
  provider: Provider;
  channel: Channel;
  codingAgent: CodingAgent;
}
