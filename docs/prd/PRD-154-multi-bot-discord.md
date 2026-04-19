# PRD-154: Multi-Bot Discord Support

> **Note (2026-04, #392):** Discord configuration moved from a top-level `discord:` block to `channels.discord.accounts.<id>`. The yaml examples below show the old shape; the multi-account model itself is unchanged. See `isotopes.example.yaml` for the current shape.

## Summary

Support multiple Discord bot tokens so each agent can have an independent bot identity.

## Current State

- `DiscordTransport` creates a single `Client` instance with one token
- `discord.token` / `discord.tokenEnv` — single token
- `discord.agentBindings` — maps bot user ID → agent ID (but only works for one bot)
- All agents share the same bot identity

## Target State

- Multiple Discord bot accounts, each with independent Client instance
- Each account has its own token, name, avatar
- Routing: `@Major` triggers Major, `@Tachikoma` triggers Tachikoma
- Same channel can have multiple bots responding independently

## Config Schema

```yaml
discord:
  accounts:
    major:                        # account ID
      token: ${DISCORD_MAJOR_TOKEN}
      defaultAgentId: major
    tachikoma:
      token: ${DISCORD_TACHIKOMA_TOKEN}
      defaultAgentId: tachikoma
  # Shared settings (inherited by all accounts)
  allowDMs: false
  channelAllowlist: [...]
  context: { ... }
  threadBindings: { ... }
```

### Backward Compatibility

Old single-bot config still works:

```yaml
discord:
  token: ${DISCORD_TOKEN}
  defaultAgentId: fairy
```

Internally normalized to:

```yaml
discord:
  accounts:
    default:
      token: ${DISCORD_TOKEN}
      defaultAgentId: fairy
```

## Implementation Plan

### 1. Config Changes (`src/core/config.ts`)

```typescript
interface DiscordAccountConfigFile {
  token?: string;
  tokenEnv?: string;
  defaultAgentId: string;
  agentBindings?: Record<string, string>;
  // Per-account overrides (optional)
  allowDMs?: boolean;
  channelAllowlist?: string[];
}

interface DiscordConfigFile {
  // New: multiple accounts
  accounts?: Record<string, DiscordAccountConfigFile>;
  
  // Legacy: single-bot (backward compat)
  token?: string;
  tokenEnv?: string;
  defaultAgentId?: string;
  agentBindings?: Record<string, string>;
  
  // Shared settings
  allowDMs?: boolean;
  channelAllowlist?: string[];
  threadBindings?: ThreadBindingConfigFile;
  subagentStreaming?: SubagentStreamingConfigFile;
  allowBots?: boolean;
  context?: ContextConfigFile;
}
```

Add `normalizeDiscordConfig()` in loadConfig:
- If `accounts` exists → use as-is
- If legacy `token`/`tokenEnv` exists → wrap in `accounts: { default: {...} }`
- Union type doesn't leak downstream

### 2. Transport Changes (`src/transports/discord.ts`)

**Strategy: Option B — Modify DiscordTransport**

- `DiscordTransport` stays single-responsibility (one Client per instance)
- New `DiscordTransportManager` creates/manages multiple `DiscordTransport` instances
- CLI creates manager instead of single transport
- **Each Client's message handler is independent** — no cross-triggering

Key implementation details:
- Each `DiscordTransport` instance has its own `accountId`
- Message handlers check `accountId` matches before processing
- `client.user.id` (bot user ID) is per-Client, naturally isolated

### 3. CLI Changes (`src/cli.ts`)

```typescript
// Old
const discordTransport = new DiscordTransport({ token, ... });
await discordTransport.start();

// New
const discordManager = new DiscordTransportManager({
  accounts: normalizedAccounts,
  sharedConfig: { context, threadBindings, ... },
  agentManager,
  sessionStore,
});
await discordManager.startAll();
```

### 4. Session Key Changes (`src/core/session-keys.ts`)

Current: `discord:{botId}:{type}:{id}:{agentId}`

With multi-bot, `botId` already distinguishes accounts — no change needed.

### 5. Binding Routing Updates

`channels` config already supports `accountId` in match:

```yaml
channels:
  guilds:
    "123456":
      requireMention:
        major: true    # accountId → requireMention
        tachikoma: false
```

`shouldRespondToMessage()` already accepts `accountId` param — should work.

## Files to Change

1. `src/core/config.ts`
   - Add `DiscordAccountConfigFile` interface
   - Add `normalizeDiscordConfig()` function
   - Update `DiscordConfigFile` with `accounts` field
   - **Pattern: Raw → Normalized, like #155**

2. `src/transports/discord.ts`
   - Extract shared config to `DiscordSharedConfig`
   - Add `DiscordTransportManager` class
   - `DiscordTransportConfig` gets `accountId` field
   - **Each Client message handler independent** — no cross-trigger

3. `src/cli.ts`
   - Use `DiscordTransportManager` when `accounts` present
   - Fallback to single `DiscordTransport` for legacy config

4. Tests
   - `src/core/config.test.ts` — normalization tests
   - `src/transports/discord.test.ts` — multi-account routing tests

## Major Review Points (from Major)

1. **Client 单实例 → per-account 多实例** — DiscordTransportManager 管理
2. **现有 `bindings[]` 有 `match.accountId`** — 确认 routing 分发正确
3. **向后兼容** — 现有 `discord.token` 必须继续工作，不能 break 自己
4. **每个 Client message handler 独立** — 避免交叉触发

## Acceptance Criteria

- [ ] Major and Tachikoma appear as two different bots in the same Discord channel
- [ ] `@Major` only triggers Major, `@Tachikoma` only triggers Tachikoma
- [ ] Each bot has independent name, avatar, identity
- [ ] Legacy single-bot config continues to work (Fairy keeps working)
- [ ] Thread bindings work across all accounts
- [ ] Subagent streaming works for each account independently

## Edge Cases

1. **Same user mentioned by multiple bots** — each bot processes independently, dedup by messageId per bot
2. **Thread created in multi-bot channel** — binds to parent channel's default agent (or first account?)
3. **Account goes offline** — other accounts continue working
