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
pnpm install

# Configure
cp config.example.yaml config.yaml
# Edit config.yaml with your settings

# Run
pnpm dev
```

## Documentation

- [PRD](docs/PRD.md) — Product Requirements Document
- [Project Board](https://github.com/orgs/GhostComplex/projects/11)

## Architecture

```
┌─────────────────────────────────────────┐
│  Transports (Discord, Feishu, Web)      │
├─────────────────────────────────────────┤
│  Orchestrator (Agent Manager, ACP)      │
├─────────────────────────────────────────┤
│  Agent Core (@openai/agents, pluggable) │
├─────────────────────────────────────────┤
│  Providers (GHC, MiniMax, OpenAI, etc.) │
└─────────────────────────────────────────┘
```

## Status

🚧 **In Development** — See [PRD](docs/PRD.md) for milestones and progress.

## License

MIT
