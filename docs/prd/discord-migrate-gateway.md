# Discord Transport Migration to Gateway

## Overview

Migrate the Discord transport from the legacy `runtime-adapter.runAgent` path to `gateway.dispatch`, relocate it from `src/legacy/discord/` to `src/channels/discord/` as the first ChannelAdapter, and prepare the structure so future channels (Feishu) can be added without touching the gateway core.

## Motivation

- Gateway (PRs #765, #769, #772) is now the canonical entrypoint, but no production caller uses it. Discord is the highest-concurrency caller — migrating it validates the gateway design under real stress (multi-user same-channel, user bursts).
- `src/legacy/discord/discord.ts` (1039 LOC) bundles too many concerns; splitting along inbound/outbound/lifecycle lines makes the code reviewable.
- The empty `src/extensions/channels/` slot is waiting for a real adapter — Discord becomes the reference implementation; Feishu later just copies the shape.
- Removes ~1500 LOC of obsolete abstractions: `runtime-adapter.runAgent`, `InboundDebouncer`, the local message buffer.

## Requirements

1. Discord transport calls `gateway.dispatch(msg, callbacks)` instead of `runtime-adapter.runAgent`.
2. All inbound concurrency (multi-user same channel, user bursts) handled by gateway's `active` map + steer + `resolveSessionId` dedupe — no local buffering in the transport.
3. Discord adapter conforms to the new `ChannelAdapter` contract: `start({gateway, config, logger}) → stop()`.
4. App.ts is no longer Discord-aware — channels are loaded via `src/extensions/channels/loader.ts`.
5. spawn_agent tool gains an optional `threadName?: string` parameter (D2b) and returns thread metadata (`{status, error?, threadId?}`) in its result so the parent agent knows whether the subagent is visible in a thread.
6. Existing user-facing Discord behavior is preserved: mention rules (precise @, DM auto-respond, reply-chain, quoted), dedupe, reply directive, send-new-message streaming, allowlist, per-guild requireMention.
7. Codebase is cleaned: legacy/discord/ deleted, runtime-adapter.ts deleted, debouncer + config field deleted.

## Acceptance Criteria

- [ ] `pnpm test` green — unit + co-located tests for new `src/channels/discord/`
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `app.ts` contains no `Discord` imports; only generic channel loader
- [ ] `src/agent/runtime-adapter.ts` deleted (no remaining importers)
- [ ] `src/legacy/discord/` deleted entirely
- [ ] `InboundDebouncer` removed from code and config schema
- [ ] Discord behavior smoke-tested: two users in same channel sending near-simultaneously hit gateway's steer path (one run, second message queued)
- [ ] `spawn_agent` tool result includes thread metadata; `threadName` param honored when provided

## Technical Approach

### Target file structure

```
src/
├── channels/
│   ├── types.ts                    # ChannelAdapter contract (new)
│   └── discord/
│       ├── index.ts                # createDiscordChannel: ChannelAdapter
│       ├── receive.ts              # ingestion + mention + dedupe + dispatch
│       ├── outbound.ts             # callbacks → SegmentedStreamBuffer + send/reply
│       ├── session-key.ts          # discord:{botId}:{channel|dm|thread}:{id}
│       ├── reply-directive.ts      # moved from legacy/gateway
│       ├── mention.ts              # moved from legacy/gateway
│       ├── dedupe.ts               # moved from legacy/gateway
│       ├── thread-binding.ts       # moved from legacy/discord/thread-bindings
│       ├── a2a-sink.ts             # moved from legacy/discord/discord-a2a-sink
│       ├── message-metadata.ts     # moved from legacy/discord
│       ├── types.ts                # moved from legacy/discord (Discord-internal types)
│       └── *.test.ts
├── extensions/
│   └── channels/
│       ├── loader.ts               # NEW: load built-in channel adapters from config
│       └── README.md               # exists
├── agent/
│   └── tools/spawn-agent.ts        # add threadName param + thread metadata in result
└── app.ts                          # delete Discord hardcode, call channel loader
```

Files deleted: `src/legacy/discord/` (entire dir), `src/legacy/gateway/{debounce,channel-history,commands}.ts` (after verifying no remaining users), `src/agent/runtime-adapter.ts`, related tests.

### ChannelAdapter contract (deliberately minimal)

```ts
// src/channels/types.ts
export interface ChannelAdapter {
  start(deps: ChannelAdapterDeps): Promise<void>;
  stop(): Promise<void>;
}
export interface ChannelAdapterDeps {
  gateway: Gateway;
  config: unknown;        // adapter narrows itself
  logger: Logger;
}
```

### Inbound flow (rewritten)

```
Discord WS event
  → src/channels/discord/receive.ts
    1. dedupe (TTL Map of messageId)
    2. mention check (4 implicit kinds preserved from legacy)
    3. resolve agentId (existing agentBindings logic)
    4. resolve sessionKey (session-key.ts)
    5. parse [[reply_to_*]] context (only the inbound-side prompt injection)
    6. build Message {agentId, sessionKey, content, extraSystemPrompt: REPLY_DIRECTIVE_PROMPT}
    7. await gateway.dispatch(msg, callbacks)
       — callbacks closure captures triggerMessage for outbound reply target
```

The gateway handles: race-safe sessionId resolution (#769), active-map serialization, steer for in-flight runs, retry-as-fresh on race. The transport does NOT maintain its own buffer.

### Outbound flow (rewritten)

```
gateway dispatch streams events through callbacks
  → src/channels/discord/outbound.ts
    onTextDelta(delta):
      buffer.append(delta)
      if buffer ≥ 500 chars AND sentence boundary: flush as new message
        — parseReplyDirective: stripped text + maybe replyToId
        — replyToId ? message.reply() : channel.send()
        — chunk if > 2000 chars
    onToolStart, onToolEnd: optional tool status messages (preserve legacy behavior)
    on agent_end: flushRemaining()
```

Edit-in-place is intentionally NOT used — multi-agent scenarios cause other bots to read truncated mid-edit content (legacy comment confirms this was a previously-fixed bug).

### Multi-bot

`agentBindings: Record<botUserId, agentId>` (existing config) is preserved as-is. Each bot has its own Discord.js client instance, all routing through the same gateway. sessionKey already includes botId so per-bot isolation is automatic.

### Thread spawn (spawn_agent integration)

`DiscordA2ASink` (existing) handles auto-thread for spawn_agent; behavior preserved. New: spawn_agent tool gains:
- `threadName?: string` — agent provides explicit thread title, falls back to auto-derived `${to}: ${content[:80]}…` if absent
- tool result includes `thread: {status: "ok"|"error"|"silent", error?, threadId?}` — parent agent knows whether subagent is visible

### Channel loader

`src/extensions/channels/loader.ts` — for v1, just imports built-in adapters and starts each iff its config block is present:

```ts
export async function loadChannels(deps: { gateway, config, logger }) {
  const adapters: ChannelAdapter[] = [];
  if (deps.config.channels?.discord) {
    const { createDiscordChannel } = await import("../../channels/discord/index.js");
    adapters.push(createDiscordChannel(deps.config.channels.discord));
  }
  // future: feishu, slack, etc.
  await Promise.all(adapters.map(a => a.start(deps)));
  return { stopAll: () => Promise.all(adapters.map(a => a.stop())) };
}
```

No autoload from `~/.isotopes/extensions/channels/` (deferred — README already states this).

## Testing Strategy

- **Co-located unit tests** for each new file (`receive.test.ts`, `outbound.test.ts`, `session-key.test.ts`, `mention.test.ts`, etc.) — most are direct ports / restructures of existing legacy tests
- **Integration test** for the `createDiscordChannel` lifecycle: instantiate with a mocked Discord client + real Gateway + mocked AgentRuntime, send a fake message, verify gateway.dispatch was called with the right Message
- **No new e2e** required — this is a refactor, not a feature add; gateway already has its own test suite proving the contract
- **Manual smoke** before merge: connect a real bot to a test Discord server, two-user same-channel ping verify steer path

Tests REMOVED:
- `legacy/discord/discord.test.ts` (1436 LOC) — replaced by smaller per-file tests
- `legacy/gateway/debounce.test.ts` — debouncer deleted

## Out of Scope

- **Feishu adapter** — only the slot is prepared; no Feishu code
- **Per-channel config override** (mention policy, model, etc.) — tracked in #774, requires a 2-level resolver not present today
- **Reply directive → per-channel `replyToMode`** — tracked in #776, behavior change deferred
- **spawn_agent non-blocking** — tracked in #775, big design question
- **LLM-generated thread titles** — D2b allows agent-provided names; that's enough
- **Edit-in-place outbound** — multi-agent unsafe per legacy comment
- **`KeyedAsyncQueue` per sessionKey** — gateway's active+steer already covers this
- **autoload of user-installed channel adapters from `~/.isotopes/extensions/channels/`** — defer until real demand
- **cron / heartbeat migration to gateway** — separate work after this lands
