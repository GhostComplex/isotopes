# 🫥 Isotopes PRD

> Version: 0.1.0 (MVP)
> Date: 2026-04-03
> Status: **Draft**

## Overview

**Isotopes** is a lightweight, self-hostable AI agent framework.

MVP scope: Multi-agent orchestration + Discord transport + OpenAI/Anthropic proxy support + ACP.

## MVP Goals

1. **Pluggable agent core** — Abstract interface, default Pi-Mono (`@mariozechner/pi-agent-core`)
2. **Multi-agent management** — Create and manage agents (JSON persisted)
3. **Discord transport** — Basic messaging + thread streaming
4. **Proxy support** — OpenAI/Anthropic compatible proxies (ollama, vllm, copilot-api, etc.)
5. **ACP protocol** — Agent Communication Protocol for inter-agent messaging

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

**Steering** is critical for real-time user interrupts (e.g., Discord messages mid-execution). Pi-Mono supports this natively; `@openai/agents` would require significant wrapper code.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Discord Transport                    │
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

## MVP Milestones

| Milestone | Scope | Timeline |
|-----------|-------|----------|
| **M0** | Core + Discord + Proxy | ~2 days |
| **M1** | Web UI (Next.js, agent dashboard, chat) | TBD |
| **M2** | Feishu Transport | TBD |
| **M3** | Self-Evolving Prompts (versioning, self-update) | TBD |
| **M4** | Full ACP Protocol (inter-agent messaging) | TBD |

### M0: Core Foundation

- [ ] Project setup (TypeScript, npm, ESM)
- [ ] Agent Core interface + Pi-Mono wrapper
- [ ] Agent Manager (JSON persisted)
- [ ] Session Store (JSONL + auto-cleanup)
- [ ] Discord transport + thread streaming
- [ ] Config loader (YAML)
- [ ] Integration test with proxy

---

## Post-MVP Roadmap

| Milestone | Scope |
|-----------|-------|
| **M5** | Hooks & Plugins System |

---

## Extension Points

| Interface | MVP Impl | Future Impl |
|-----------|----------|-------------|
| `AgentCore` | `PiMonoCore` | Custom agent loop |
| `AgentManager` | `JsonAgentManager` | — |
| `SessionStore` | `JsonlSessionStore` | `SqliteSessionStore` |
| `Transport` | `DiscordTransport` | `FeishuTransport`, `WebTransport` |
