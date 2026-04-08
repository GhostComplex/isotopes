# 🫥 Isotopes PRD

> Version: 0.2.0
> Date: 2026-04-08
> Status: **In Progress**

## Overview

**Isotopes** is a lightweight, self-hostable AI agent framework designed for multi-agent collaboration on Discord.

MVP scope: Multi-agent orchestration + Discord transport + OpenAI/Anthropic proxy support + Tool system.

## Target Use Case

Multi-agent team collaboration in Discord channels:
- **Human** directs work via @mentions
- **Manager Agent** reviews PRs, tracks progress, assigns tasks
- **Dev Agent** writes code, creates PRs, responds to reviews
- **Multiple agents** in same channel, each with distinct role

## MVP Goals

1. **Pluggable Agent Core** — Abstract interface, default Pi-Mono (`@mariozechner/pi-agent-core`)
2. **Multi-Agent Management** — Create and manage multiple agents with distinct personas
3. **Discord Transport** — Channel + Thread support with @mention routing
4. **@Mention Routing** — Route messages to correct agent based on @mention
5. **Multi-Agent Same Channel** — Multiple agents listening to same channel
6. **Steering** — Real-time user interrupts via `agent.steer()` / `agent.followUp()`
7. **Tool System** — Shell exec, file read/write, extensible
8. **Proxy Support** — OpenAI/Anthropic compatible proxies (ollama, vllm, copilot-api)
9. **JSONL Sessions** — Conversation history with auto-cleanup

---

## Why Pi-Mono?

We chose `@mariozechner/pi-agent-core` over `@openai/agents` for the following reasons:

| Feature | Pi-Mono | @openai/agents |
|---------|---------|----------------|
| **Steering** | ✅ `agent.steer()` native | ❌ Not supported |
| **Follow-up** | ✅ `agent.followUp()` native | ❌ Not supported |
| **Code size** | ~1.9K lines | ~3MB |
| **Provider support** | OpenAI + Anthropic | OpenAI only |
| **OpenClaw compatibility** | ✅ Same core | ⚠️ Needs adapter |

**Steering** is critical for real-time user interrupts (e.g., Discord messages mid-execution).

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Discord Transport                    │
│  - Channel + Thread listening                           │
│  - @mention routing                                     │
│  - Multi-agent same channel                             │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                     Orchestrator                        │
│      Agent Manager  +  Session Store  →  Data Layer     │
│                                          (JSON/JSONL)   │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│         Agent Core (Pluggable: @mariozechner/pi-*)      │
│                      + Tool System                      │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│    Providers (OpenAI Proxy | Anthropic Proxy | Direct)  │
└─────────────────────────────────────────────────────────┘
```

See [DESIGN.md](./DESIGN.md) for detailed architecture and interfaces.

---

## Data Structure

```
~/.isotopes/
├── isotopes.yaml            # Config file
├── workspaces/
│   └── {agentId}/
│       ├── SOUL.md          # System prompt (markdown)
│       ├── TOOLS.md         # Tool instructions (optional)
│       ├── MEMORY.md        # Persistent memory (optional)
│       └── sessions/
│           ├── sessions.json    # Session index
│           └── {sessionId}.jsonl
└── logs/
    └── isotopes-YYYY-MM-DD.log
```

---

## Milestones

| Milestone | Scope | Timeline |
|-----------|-------|----------|
| **M0** | Core + Discord + Tools + Proxy | ~3 days |
| **M1** | Cron Jobs + Git/GitHub tools | TBD |
| **M2** | ACP Protocol + Daemon mode | TBD |
| **M3** | Web UI (agent dashboard, chat) | TBD |
| **M4** | Self-Evolving Prompts (versioning, self-update) | TBD |
| **M5** | Feishu Transport | TBD |

### M0: Core Foundation

- [x] Project setup (TypeScript, pnpm, ESM)
- [x] Agent Core interface + Pi-Mono wrapper
- [x] Agent Manager
- [x] Session Store (JSONL + key-based lookup)
- [x] Discord transport
  - [x] Channel message listening
  - [x] Thread support
  - [x] @mention routing to correct agent
  - [x] Multi-agent same channel config
- [x] Tool System
  - [x] Shell exec
  - [x] File read/write/list
  - [x] Tool registration interface
- [x] Config loader (YAML, `~/.isotopes/isotopes.yaml`)
- [x] Proxy support (OpenAI/Anthropic compatible)
- [x] Multi-turn conversation (session history passed to agent)
- [x] Structured message content (MessageContentBlock)
- [ ] Workspace injection (SOUL.md → system prompt)
- [ ] Context compaction (summarize old messages to avoid context overflow)
- [ ] Session auto-cleanup (TTL-based)

### M1: Automation & Git

- [ ] Cron Job scheduler
  - [ ] Channel-level cron (daily standups, reports)
  - [ ] Agent self-registered cron
- [ ] Git/GitHub tools
  - [ ] gh CLI wrapper
  - [ ] PR create/review/merge
- [ ] Workspace hot-reload
  - [ ] fs.watch on workspace files (SOUL.md, MEMORY.md, etc.)
  - [ ] Auto-reload prompt when files change

### M2: ACP Protocol + Daemon

- [ ] ACP Protocol
  - [ ] Inter-agent messaging
  - [ ] Thread ACP
- [ ] Daemon mode
  - [ ] `isotopes start/stop/status` commands
  - [ ] launchd (macOS) / systemd (Linux) service management
  - [ ] Log rotation

---

## Post-MVP Roadmap

| Milestone | Scope |
|-----------|-------|
| **M6** | Hooks & Plugins System |

---

## Extension Points

| Interface | MVP Impl | Future Impl |
|-----------|----------|-------------|
| `AgentCore` | `PiMonoCore` | Custom agent loop |
| `AgentManager` | `JsonAgentManager` | — |
| `SessionStore` | `JsonlSessionStore` | `SqliteSessionStore` |
| `Transport` | `DiscordTransport` | `FeishuTransport`, `WebTransport` |
| `Tool` | `ShellTool`, `FileTool` | `GitHubTool`, `WebSearchTool` |
