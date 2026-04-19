# Development

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Transports                            │
│    Discord Transport  |  Feishu Transport  |  Web API       │
└──────────────┬────────────────┬───────────────┬─────────────┘
               │                │               │
┌──────────────┴────────────────┴───────────────┴─────────────┐
│                      Message Router                         │
│   - Binding resolution (channel + account + peer)           │
│   - Mention filtering (requireMention per guild/group)      │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                      Orchestrator                           │
│  Agent Manager  +  Session Store  +  Cron Scheduler         │
│  Workspace Watcher  +  Config Reloader  +  Compaction       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│          Agent Core (Pluggable: @mariozechner/pi-*)         │
│       Tool System  +  Sandbox Executor (Docker)             │
│       Git/GitHub Tools  +  File/Shell Tools                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│     Providers (OpenAI Proxy | Anthropic Proxy | Direct)     │
└─────────────────────────────────────────────────────────────┘
```

## Local setup

```bash
git clone https://github.com/GhostComplex/isotopes
cd isotopes
pnpm install

pnpm build                     # Compile TypeScript
pnpm dev                       # Run without building (tsx)
pnpm test                      # Unit tests (vitest)
pnpm test:watch                # Watch mode
pnpm lint                      # ESLint
pnpm typecheck                 # TypeScript type checking
pnpm run ci                    # lint + typecheck + test
```

## Integration tests

```bash
export DISCORD_TOKEN="your-bot-token"
export DISCORD_TEST_CHANNEL="channel-id"
export ANTHROPIC_API_KEY="sk-ant-..."
pnpm test:integration
```

See [tests/integration/README.md](../tests/integration/README.md) for setup details.

## Project structure

```
src/
├── core/               # Core components
│   ├── types.ts            # All framework interfaces and types
│   ├── pi-mono.ts          # Pi-Mono agent wrapper
│   ├── agent-manager.ts    # Agent lifecycle management
│   ├── agent-runner.ts     # Agent execution loop
│   ├── session-store.ts    # JSONL session persistence
│   ├── session-keys.ts     # Session key generation
│   ├── tools.ts            # Tool registry and built-in tools
│   ├── workspace.ts        # Workspace context loading (SOUL/TOOLS/MEMORY)
│   ├── bindings.ts         # Message-to-agent routing
│   ├── thread-bindings.ts  # Discord thread auto-binding
│   ├── mention.ts          # @mention detection
│   ├── compaction.ts       # Context window compaction
│   ├── config.ts           # YAML config loader + validation
│   ├── paths.ts            # Path resolution (~/.isotopes/...)
│   └── logger.ts           # Structured logging
├── transports/         # Transport implementations
│   ├── discord.ts          # Discord (channels, threads, DMs)
│   └── feishu.ts           # Feishu/Lark (groups, P2P, WebSocket)
├── automation/         # Scheduled tasks
│   ├── cron-parser.ts      # Cron expression parsing
│   └── cron-job.ts         # Job scheduler
├── tools/              # Extended tool implementations
│   ├── git.ts              # Git CLI wrapper
│   └── github.ts           # GitHub CLI wrapper (PRs, issues)
├── api/                # Web API
│   ├── server.ts           # HTTP server (Node built-in)
│   ├── routes.ts           # REST endpoints
│   └── middleware.ts       # Request handling
├── daemon/             # Background process management
│   ├── process.ts          # PID-based daemon lifecycle
│   ├── service.ts          # launchd/systemd integration
│   └── log-rotation.ts     # Log file rotation
├── sandbox/            # Sandboxed execution
│   ├── config.ts           # Sandbox configuration
│   ├── container.ts        # Docker container management
│   └── executor.ts         # Sandboxed tool execution
├── workspace/          # Workspace file watching
│   ├── watcher.ts          # File system watcher
│   └── config-reloader.ts  # Hot-reload on config changes
├── version.ts          # VERSION constant
└── cli.ts              # CLI entry point
```

## Reference docs

- [PRD](PRD.md) — Product Requirements Document
- [Design](DESIGN.md) — Technical Design Document

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes with tests
4. Run `pnpm run ci` to verify
5. Commit with conventional commits (`feat:`, `fix:`, `docs:`, etc.)
6. Open a PR
