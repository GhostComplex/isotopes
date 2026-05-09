// src/plugins/discord/config.ts — Discord-specific config helpers

import type { DiscordAccountConfig } from "../../channels/discord/types.js";

export function getDiscordToken(account: DiscordAccountConfig): string {
  if (account.token) {
    return account.token;
  }
  if (account.tokenEnv) {
    const token = process.env[account.tokenEnv];
    if (!token) {
      throw new Error(`Environment variable ${account.tokenEnv} is not set`);
    }
    return token;
  }
  throw new Error("Discord account config must have either 'token' or 'tokenEnv'");
}
