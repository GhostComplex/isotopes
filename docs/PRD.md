# 🫥 Isotopes PRD

> Version: 0.3.0
> Date: 2026-04-08
> Status: **Complete**

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

Extensible via tool registration.

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
├── workspaces/
│   └── {agentId}/
│       ├── SOUL.md          # System prompt
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

| Milestone | Scope | Status |
|-----------|-------|--------|
| **M0** | Core Foundation | ✅ Done |
| **M1** | Config & Routing Enhancements | ✅ Done |
| **M2** | Feishu Transport | ✅ Done |
| **M3** | ACP Protocol | ✅ Done |
| **M4** | Automation & Git | ✅ Done |
| **M5** | Daemon Mode + Web API | ✅ Done |
| **M6** | Sandbox Execution | ✅ Done |

---

### M0: Core Foundation ✅

- [x] Project setup (TypeScript, pnpm, ESM)
- [x] Agent Core interface + Pi-Mono wrapper
- [x] Agent Manager
- [x] Session Store (JSONL + key-based lookup)
- [x] Discord transport (channels + threads + @mention)
- [x] Tool System (shell, file read/write/list)
- [x] Config loader (YAML, `~/.isotopes/isotopes.yaml`)
- [x] Proxy support (OpenAI/Anthropic compatible)
- [x] Structured message content (MessageContentBlock)

---

### M1: Config & Routing Enhancements ✅

**Goal:** Full parity with OpenClaw's routing capabilities.

#### 1.1 Bindings System
```yaml
bindings:
  - agentId: major
    match:
      channel: discord
      accountId: major
  - agentId: sac-chromium
    match:
      channel: discord
      accountId: laughingman
      peer:
        kind: group
        id: "1484372470306963547"
```

- [x] Binding resolution by (channel, accountId, peer)
- [x] Priority: more specific bindings win
- [x] Support `peer.kind`: `group`, `dm`, `thread`

#### 1.2 Require Mention
```yaml
channels:
  discord:
    accounts:
      major:
        guilds:
          "guild_id":
            requireMention: false
```

- [x] Per-guild/group `requireMention` config
- [x] Default: `true` (only respond when @mentioned)
- [x] Mention detection via Discord.js

#### 1.3 Workspace Injection
- [x] Load `SOUL.md` as system prompt
- [x] Load `TOOLS.md` as tool instructions
- [x] Load `MEMORY.md` as persistent context

#### 1.4 Context Compaction
```yaml
agents:
  defaults:
    compaction:
      mode: safeguard  # off | safeguard | aggressive
```

- [x] Implement `transformContext` hook
- [x] LLM-based summarization for old messages
- [x] Token counting and threshold detection

#### 1.5 Session Management
- [x] Session auto-cleanup (TTL-based)
- [x] Session recovery after restart

---

### M2: Feishu Transport ✅

**Goal:** Support Feishu (Lark) as second transport.

#### 2.1 Feishu SDK Integration
```yaml
channels:
  feishu:
    enabled: true
    connectionMode: websocket
    accounts:
      major:
        appId: "..."
        appSecret: "..."
```

- [x] Feishu WebSocket connection
- [x] Event handling (message.receive, etc.)
- [x] Message sending (text, rich text, cards)

#### 2.2 Feishu Groups
```yaml
channels:
  feishu:
    groups:
      "oc_xxx":
        requireMention: false
```

- [x] Group message handling
- [x] P2P chat handling
- [x] Group-level `requireMention`

#### 2.3 Feishu Bindings
```yaml
bindings:
  - agentId: major
    match:
      channel: feishu
      accountId: major
```

- [x] Feishu account binding
- [x] Group-specific binding

---

### M3: ACP Protocol ✅

**Goal:** Agent Communication Protocol for external tool integration.

#### 3.1 Thread Bindings
```yaml
channels:
  discord:
    threadBindings:
      enabled: true
      spawnAcpSessions: true
```

- [x] Detect thread creation
- [x] Auto-spawn ACP session in thread
- [x] Session lifecycle tied to thread

#### 3.2 ACP Backend
```yaml
acp:
  enabled: true
  backend: acpx
  defaultAgent: claude
  allowedAgents:
    - claude
```

- [x] ACP session management
- [x] Claude Code integration
- [x] Codex integration

#### 3.3 Inter-Agent Messaging
- [x] Agent → Agent communication
- [x] Message routing between agents
- [x] Shared context (optional)

---

### M4: Automation & Git ✅

#### 4.1 Cron Jobs
- [x] Channel-level cron (daily standups)
- [x] Agent self-registered cron
- [x] Cron expression parser

#### 4.2 Git/GitHub Tools
- [x] gh CLI wrapper
- [x] PR create/review/merge
- [x] Issue management

#### 4.3 Workspace Hot-Reload
- [x] fs.watch on workspace files
- [x] Auto-reload on change

---

### M5: Daemon Mode + Web API ✅

#### 5.1 Daemon Mode
- [x] `isotopes start/stop/status`
- [x] launchd (macOS) / systemd (Linux)
- [x] Log rotation

#### 5.2 Web API
- [x] REST API server (Node.js built-in http)
- [x] Agent dashboard (GET /api/status, GET /api/sessions)
- [x] Session viewer (GET /api/sessions/:id, POST /api/sessions/:id/message)
- [x] Config editor (GET /api/config, PUT /api/config)
- [x] Cron management (GET/POST/DELETE /api/cron)

---

### M6: Sandbox Execution ✅

**Goal:** Secure tool execution in isolated Docker containers.

#### 6.1 Sandbox Config
```yaml
agents:
  defaults:
    sandbox:
      mode: non-main   # off | non-main | all
      workspaceAccess: rw
      docker:
        image: isotopes-sandbox:latest
        network: bridge
        extraHosts:
          - "host.docker.internal:host-gateway"
  list:
    - id: major
      sandbox:
        mode: off  # Per-agent override
```

- [x] Sandbox mode: `off` (no sandbox), `non-main` (sandbox non-main agents), `all` (sandbox everything)
- [x] Workspace mounting with access control (`rw`, `ro`)
- [x] Per-agent sandbox override

#### 6.2 Docker Integration
- [x] Docker container lifecycle management
- [x] Volume mounting for workspace
- [x] Network configuration (bridge, host, none)
- [x] Resource limits (CPU, memory)

#### 6.3 Sandboxed Tool Execution
- [x] Route `shell` tool through container
- [x] File operations inside container
- [x] Secure environment variable handling

#### 6.4 Sandbox Image
- [x] Base image with common dev tools
- [x] `isotopes-sandbox:latest` default image
- [x] Custom image support

---

## Extension Points

| Interface | Current Impl | Future Impl |
|-----------|--------------|-------------|
| `AgentCore` | `PiMonoCore` | Custom agent loop |
| `AgentManager` | `DefaultAgentManager` | — |
| `SessionStore` | `DefaultSessionStore` | `SqliteSessionStore` |
| `Transport` | `DiscordTransport` | `FeishuTransport`, `WebTransport` |
| `Tool` | `ShellTool`, `FileTool` | `GitHubTool`, `WebSearchTool` |

---

## Config Schema Reference

Full YAML schema: [CONFIG_SCHEMA.md](./CONFIG_SCHEMA.md) (TBD)

Key differences from OpenClaw:
- YAML instead of JSON (more readable for humans)
- Simplified structure (no `meta`, `wizard`, `gateway` sections)
- Focus on agent orchestration (no node management)
