# 🫥 Isotopes PRD

> Version: 0.1.0 (MVP)
> Date: 2026-04-02
> Status: **Draft**

## Overview

**Isotopes** is a lightweight, self-hostable AI agent framework.

MVP scope: Multi-agent orchestration + Discord transport + OpenAI/Anthropic proxy support.

## MVP Goals

1. **Pluggable agent core** — Abstract interface, default `@openai/agents`
2. **Multi-agent management** — Create and manage agents (JSON persisted)
3. **Discord transport** — Basic messaging + thread streaming
4. **Proxy support** — OpenAI/Anthropic compatible proxies (ollama, vllm, copilot-api, etc.)

## Non-Goals (MVP)

- ❌ Web UI → Future M1
- ❌ Feishu transport → Future M2
- ❌ Self-evolving prompts → Future M3
- ❌ Full ACP protocol → Simplified for MVP

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Discord Transport                    │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                     Orchestrator                        │
│         Agent Manager (JSON)  +  Session Store (JSONL)  │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│            Agent Core (Pluggable: @openai/agents)       │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│    Providers (OpenAI Proxy | Anthropic Proxy | Direct)  │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                     Data Layer                          │
│  data/agents.json + data/agents/{id}/SOUL.md + sessions │
└─────────────────────────────────────────────────────────┘
```

See [DESIGN.md](./DESIGN.md) for detailed architecture and interfaces.

---

## Data Structure

```
data/
├── agents.json              # Agent metadata (id, name, provider)
└── agents/{agentId}/
    ├── SOUL.md              # System prompt (markdown)
    ├── TOOLS.md             # Tool instructions (optional)
    ├── MEMORY.md            # Persistent memory (optional)
    └── sessions/
        └── {sessionId}.jsonl
```

---

## Configuration

```yaml
# config.yaml

providers:
  openai-proxy:
    baseUrl: http://localhost:4141/v1
  anthropic-proxy:
    baseUrl: http://localhost:4141/v1

defaultProvider: openai-proxy
defaultModel: claude-sonnet-4-20250514

discord:
  token: ${DISCORD_TOKEN}

storage:
  dataDir: ./data
  maxSessions: 100
  maxTotalSizeMB: 100
```

---

## MVP Milestone (M0)

**Timeline:** ~2 days with Claude Code

- [ ] Project setup (TypeScript, pnpm, ESM)
- [ ] Agent Core interface + @openai/agents wrapper
- [ ] Agent Manager (JSON persisted)
- [ ] Session Store (JSONL + auto-cleanup)
- [ ] Discord transport + thread streaming
- [ ] Config loader (YAML)
- [ ] Integration test with proxy

---

## Post-MVP Roadmap

| Milestone | Scope |
|-----------|-------|
| **M1** | Web UI (Next.js, agent dashboard, chat interface) |
| **M2** | Feishu Transport |
| **M3** | Self-Evolving Prompts (versioning, self-update) |
| **M4** | Full ACP Protocol (inter-agent messaging) |
| **M5** | Hooks & Plugins System |

---

## Extension Points

| Interface | MVP Impl | Future Impl |
|-----------|----------|-------------|
| `AgentCore` | `OpenAIAgentsCore` | Custom agent loop |
| `AgentManager` | `JsonAgentManager` | — |
| `SessionStore` | `JsonlSessionStore` | `SqliteSessionStore` |
| `Transport` | `DiscordTransport` | `FeishuTransport`, `WebTransport` |
