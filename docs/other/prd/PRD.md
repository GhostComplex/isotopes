# 🫥 Isotopes PRD

> Version: 0.4.0  
> Date: 2026-04-09  
> Status: **Active Development**

## Overview

**Isotopes** is a lightweight, self-hostable AI agent framework designed for multi-agent collaboration across chat platforms (Discord, Feishu).

MVP scope: Multi-agent orchestration + Discord/Feishu transport + OpenAI/Anthropic proxy support + Tool system + ACP protocol.

## Target Use Case

Multi-agent team collaboration in chat channels:
- **Human** directs work via @mentions
- **Manager Agent** reviews PRs, tracks progress, assigns tasks
- **Dev Agent** writes code, creates PRs, responds to reviews
- **Multiple agents** in same channel, each with distinct role
- **Cross-platform** — same agent can respond on Discord and Feishu

---

## Configuration Overview

Based on OpenClaw's `openclaw.json` schema, Isotopes should support:

### Core Config Structure

```yaml
# isotopes.yaml

# Model providers (OpenAI/Anthropic proxy)
models:
  providers:
    copilot-proxy:
      baseUrl: http://localhost:4141/v1
      apiKey: n/a
      models:
        - id: claude-opus-4.5
          contextWindow: 128000
          maxTokens: 8192

# Agent definitions
agents:
  defaults:
    model:
      primary: copilot-proxy/claude-opus-4.5
    workspace: ~/.isotopes/workspaces/default
    compaction:
      mode: safeguard  # off | safeguard | aggressive
    sandbox:
      mode: non-main   # off | non-main | all
      workspaceAccess: rw
      docker:
        image: isotopes-sandbox:latest
        network: bridge
      mode: safeguard  # off | safeguard | aggressive
  list:
    - id: major
      name: Major
      workspace: ~/.isotopes/workspaces/major
    - id: tachikoma
      name: Tachikoma
      workspace: ~/.isotopes/workspaces/tachikoma

# Agent ↔ Channel bindings
bindings:
  - agentId: major
    match:
      channel: discord
      accountId: major
  - agentId: major
    match:
      channel: feishu
      accountId: major
  - agentId: tachikoma
    match:
      channel: discord
      accountId: tachikoma
      peer:
        kind: group
        id: "1484372470306963547"  # Bind to specific channel only

# Channel configurations
channels:
  discord:
    enabled: true
    accounts:
      major:
        token: "..."
        groupPolicy: allowlist
        guilds:
          "1480866703880487034":
            requireMention: false  # Respond without @mention
      tachikoma:
        token: "..."
        guilds:
          "1480866703880487034":
            requireMention: true   # Only respond when @mentioned
    threadBindings:
      enabled: true
      spawnAcpSessions: true

  feishu:
    enabled: true
    connectionMode: websocket
    accounts:
      major:
        appId: "..."
        appSecret: "..."
    groups:
      "oc_02d6d44d519f9c66dc7d311114a8a8a0":
        requireMention: false

# ACP (Agent Communication Protocol)
acp:
  enabled: true
  backend: acpx
  defaultAgent: claude
  allowedAgents:
    - claude
```

---

## Key Features

### 1. Multi-Agent Management
- Multiple agents with distinct personas
- Each agent has its own workspace (`SOUL.md`, `MEMORY.md`, etc.)
- Agents can run independently or collaborate

### 2. Agent Bindings
Match rules for routing messages to agents:

```yaml
bindings:
  # Simple: agent bound to entire Discord account
  - agentId: major
    match:
      channel: discord
      accountId: major

  # Specific: agent bound to specific guild/channel
  - agentId: sac-chromium
    match:
      channel: discord
      accountId: laughingman
      peer:
        kind: group
        id: "1484372470306963547"
```

Priority: More specific bindings take precedence.

### 3. Require Mention
Per-guild/group configuration for whether @mention is required:

```yaml
channels:
  discord:
    accounts:
      major:
        guilds:
          "1480866703880487034":
            requireMention: false  # Auto-respond to all messages
```

Use cases:
- `requireMention: false` — Dedicated project channel, agent is always active
- `requireMention: true` (default) — Shared channel, only respond when called

### 4. Multi-Platform Support
- **Discord**: Channels, threads, DMs
- **Feishu**: Groups, P2P chats, WebSocket connection

### 5. ACP Protocol
Agent Communication Protocol for:
- Thread bindings — spawn ACP sessions in Discord threads
- Inter-agent messaging
- External tool integration (Claude Code, Codex)

### 6. Tool System
Built-in tools:
- `shell` — Execute shell commands
- `read_file`, `write_file`, `list_dir` — File operations
- `get_current_time` — Current timestamp
- `iterate_self`, `create_skill`, `append_memory` — Self-iteration tools

Extensible via tool registration.

### 7. Skills System
On-demand loading of task-specific instructions:
- Skills discovered from `~/.isotopes/skills/` and `{workspace}/skills/`
- SKILL.md format with frontmatter (name, description)
- Progressive disclosure — only descriptions in system prompt, full content loaded on-demand
- Compatible with [AgentSkills spec](https://agentskills.io/specification)

### 8. Self-Iteration
Agents can modify their own configuration:
- Update SOUL.md, MEMORY.md, TOOLS.md via `iterate_self` tool
- Create new skills via `create_skill` tool
- Append learnings via `append_memory` tool
- Hot-reload system applies changes without restart

---

## Why Pi-Mono?

| Feature | Pi-Mono | @openai/agents |
|---------|---------|----------------|
| **Steering** | ✅ `agent.steer()` native | ❌ Not supported |
| **Follow-up** | ✅ `agent.followUp()` native | ❌ Not supported |
| **Code size** | ~1.9K lines | ~3MB |
| **Provider support** | OpenAI + Anthropic | OpenAI only |

**Steering** is critical for real-time user interrupts (e.g., Discord messages mid-execution).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Transports                            │
│    Discord Transport  |  Feishu Transport  |  CLI           │
└──────────────┬────────────────┬───────────────┬─────────────┘
               │                │               │
┌──────────────┴────────────────┴───────────────┴─────────────┐
│                      Message Router                         │
│   - Binding resolution (channel + account + peer)           │
│   - Mention filtering (requireMention)                      │
│   - ACP protocol handling                                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                      Orchestrator                           │
│      Agent Manager  +  Session Store  →  Data Layer         │
│                                          (JSONL)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│          Agent Core (Pluggable: @mariozechner/pi-*)         │
│                       + Tool System                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│     Providers (OpenAI Proxy | Anthropic Proxy | Direct)     │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Structure

```
~/.isotopes/
├── isotopes.yaml            # Main config
├── skills/                  # Global skills
│   └── {skill-name}/
│       └── SKILL.md
├── workspaces/
│   └── {agentId}/
│       ├── SOUL.md          # System prompt
│       ├── TOOLS.md         # Tool instructions (optional)
│       ├── MEMORY.md        # Persistent memory (optional)
│       ├── skills/          # Workspace-local skills
│       │   └── {skill-name}/
│       │       └── SKILL.md
│       └── sessions/
│           ├── sessions.json    # Session index
│           └── {sessionId}.jsonl
└── logs/
    └── isotopes-YYYY-MM-DD.log
```

---

## Milestones

| Milestone | Scope | Status |
|-----------|-------|--------|
| **M0** | Core Foundation | ✅ Done |
| **M1** | Config & Routing Enhancements | ✅ Done |
| **M2** | Feishu Transport | ✅ Done |
| **M3** | ACP Protocol | ✅ Done |
| **M4** | Automation & Git | ✅ Done |
| **M5** | Daemon Mode + Web API | ✅ Done |
| **M6** | Sandbox Execution | ✅ Done |
| **M7** | Sub-agent Backend | ✅ Done |
| **M8** | Subagent Security & Config | 📋 Backlog |
| **M9** | Skills System | ✅ Done |
| **M10** | Self-Iteration System | ✅ Done |

> **Completed milestones (M0-M7)**: See [archived/PRD-milestones-M0-M7.md](./archived/PRD-milestones-M0-M7.md)  
> **M9 Skills**: See [archived/PRD-M9-skills.md](./archived/PRD-M9-skills.md)  
> **M10 Self-Iteration**: See [archived/PRD-M10-self-iteration.md](./archived/PRD-M10-self-iteration.md)  
> **Backlog items**: See [backlog/](./backlog/)

---

## Extension Points

| Interface | Current Impl | Future Impl |
|-----------|--------------|-------------|
| `AgentCore` | `PiMonoCore` | Custom agent loop |
| `AgentManager` | `DefaultAgentManager` | — |
| `SessionStore` | `DefaultSessionStore` | `SqliteSessionStore` |
| `Transport` | `DiscordTransport`, `FeishuTransport` | `WebTransport` |
| `Tool` | `ToolRegistry` (shell, file, git, github, self-iteration) | `WebSearchTool` |

---

## Config Schema Reference

Full YAML schema: [CONFIG_SCHEMA.md](./CONFIG_SCHEMA.md) (TBD)

Key differences from OpenClaw:
- YAML instead of JSON (more readable for humans)
- Simplified structure (no `meta`, `wizard`, `gateway` sections)
- Focus on agent orchestration (no node management)
