# 🫥 Isotopes

A lightweight, self-hostable AI agent framework.

## What is this?

Isotopes is a simpler alternative to OpenClaw. It provides:

- **Multi-agent orchestration** — Create and coordinate multiple AI agents
- **Self-evolving prompts** — Agents can update their own system prompts
- **ACP support** — Agent Communication Protocol for inter-agent messaging
- **Pluggable transports** — Discord (with thread streaming), Feishu, Web UI
- **Local-first** — Everything runs on your machine

## Quick Start

```bash
# Install
pnpm install -g isotopes

# Initialize (creates ~/.isotopes/)
mkdir -p ~/.isotopes
cp isotopes.example.yaml ~/.isotopes/isotopes.yaml
# Edit ~/.isotopes/isotopes.yaml with your settings

# Run
isotopes
```

## Directory Structure

```
~/.isotopes/
├── isotopes.yaml           # Main config file
├── workspaces/
│   ├── assistant/          # Per-agent workspace
│   │   ├── SOUL.md         # Agent personality
│   │   ├── MEMORY.md       # Long-term memory
│   │   └── sessions/       # Conversation history
│   │       └── *.jsonl
│   └── dev/
│       └── ...
└── logs/
    └── isotopes-*.log
```

Override with `ISOTOPES_HOME` environment variable.

## Usage

```bash
isotopes           # Start agents
isotopes --help    # Show help
isotopes --version # Show version
```

## Configuration

```yaml
# ~/.isotopes/isotopes.yaml
provider:
  type: anthropic
  model: claude-sonnet-4-20250514
  apiKey: ${ANTHROPIC_API_KEY}

tools:
  cli: false
  fs:
    workspaceOnly: true

agents:
  - id: assistant
    name: Assistant
    # Optional: custom workspace path (default: ~/.isotopes/workspaces/<id>)
    # workspacePath: /custom/path

discord:
  tokenEnv: DISCORD_TOKEN
  defaultAgentId: assistant
```

See [isotopes.example.yaml](isotopes.example.yaml) for full options.

### Tool Guards

Tool guards live in the same `isotopes.yaml` file.

```yaml
tools:
  cli: false
  fs:
    workspaceOnly: true

agents:
  - id: assistant
    name: Assistant
    tools:
      cli: true
```

- `tools.cli`: enables shell/CLI command execution. Default is `false`.
- `tools.fs.workspaceOnly`: restricts file tools to the agent workspace. Default is `true`.
- `agents[].tools`: overrides the global defaults for a single agent.

## Logging

```bash
# Enable debug logs
LOG_LEVEL=debug isotopes

# Or use DEBUG flag
DEBUG=isotopes isotopes
```

Log levels: `debug`, `info`, `warn`, `error` (default: `info`)

## Documentation

- [PRD](docs/PRD.md) — Product Requirements Document
- [Design](docs/DESIGN.md) — Technical Design Document
- [Project Board](https://github.com/orgs/GhostComplex/projects/11)

## Architecture

```
┌─────────────────────────────────────────┐
│  Transports (Discord, Feishu, Web)      │
├─────────────────────────────────────────┤
│  Orchestrator (Agent Manager, ACP)      │
├─────────────────────────────────────────┤
│  Agent Core (Pi-Mono, pluggable)        │
├─────────────────────────────────────────┤
│  Providers (Anthropic, OpenAI, etc.)    │
└─────────────────────────────────────────┘
```

## Status

🚧 **In Development** — See [PRD](docs/PRD.md) for milestones and progress.

## Development

```bash
# Clone & install
git clone https://github.com/GhostComplex/isotopes
cd isotopes
pnpm install

# Build
pnpm build

# Run locally (without building)
pnpm dev

# Run tests
pnpm test              # Unit tests
pnpm test:watch    # Watch mode

# Lint & typecheck
pnpm lint
pnpm typecheck

# Full CI check
pnpm ci            # lint + typecheck + test
```

### Integration Testing

Integration tests require real credentials:

```bash
export DISCORD_TOKEN="your-bot-token"
export DISCORD_TEST_CHANNEL="channel-id"
export ANTHROPIC_API_KEY="sk-ant-..."

pnpm test:integration
```

See [tests/integration/README.md](tests/integration/README.md) for setup details.

### Project Structure

```
src/
├── core/           # Core components
│   ├── types.ts        # Type definitions
│   ├── pi-mono.ts      # Pi-Mono wrapper
│   ├── agent-manager.ts
│   ├── session-store.ts
│   ├── tools.ts
│   ├── workspace.ts
│   ├── config.ts
│   └── logger.ts
├── transports/     # Transport implementations
│   └── discord.ts
├── cli.ts          # CLI entry point
└── index.ts        # Public API exports
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes with tests
4. Run `pnpm ci` to verify
5. Commit with conventional commits (`feat:`, `fix:`, `docs:`, etc.)
6. Open a PR

## License

MIT
