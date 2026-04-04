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
npm install -g isotopes

# Configure
cp isotopes.example.yaml isotopes.yaml
# Edit isotopes.yaml with your settings

# Run
isotopes
```

## CLI Usage

```bash
isotopes                    # Load isotopes.yaml from current dir
isotopes ./my-project       # Load from directory
isotopes -c config.yaml     # Load specific file
```

## Configuration

```yaml
# isotopes.yaml
provider:
  type: anthropic
  model: claude-sonnet-4-20250514
  apiKey: ${ANTHROPIC_API_KEY}

agents:
  - id: assistant
    name: Assistant
    workspacePath: ./workspaces/assistant

discord:
  tokenEnv: DISCORD_TOKEN
  defaultAgentId: assistant
```

See [isotopes.example.yaml](isotopes.example.yaml) for full options.

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

## License

MIT
