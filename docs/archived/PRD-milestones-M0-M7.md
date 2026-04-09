# Archived Milestones: M0 - M7

> Archived: 2026-04-09  
> Status: **All Complete**

This document contains the detailed specifications for completed milestones M0 through M7. For current work, see the main [PRD.md](../PRD.md) and [backlog/](../backlog/).

---

## M0: Core Foundation ✅

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

## M1: Config & Routing Enhancements ✅

**Goal:** Full parity with OpenClaw's routing capabilities.

### 1.1 Bindings System
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

### 1.2 Require Mention
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

### 1.3 Workspace Injection
- [x] Load `SOUL.md` as system prompt
- [x] Load `TOOLS.md` as tool instructions
- [x] Load `MEMORY.md` as persistent context

### 1.4 Context Compaction
```yaml
agents:
  defaults:
    compaction:
      mode: safeguard  # off | safeguard | aggressive
```

- [x] Implement `transformContext` hook
- [x] LLM-based summarization for old messages
- [x] Token counting and threshold detection

### 1.5 Session Management
- [x] Session auto-cleanup (TTL-based)
- [x] Session recovery after restart

---

## M2: Feishu Transport ✅

**Goal:** Support Feishu (Lark) as second transport.

### 2.1 Feishu SDK Integration
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

### 2.2 Feishu Groups
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

### 2.3 Feishu Bindings
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

## M3: ACP Protocol ✅

**Goal:** Agent Communication Protocol for external tool integration.

### 3.1 Thread Bindings
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

### 3.2 ACP Backend
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

### 3.3 Inter-Agent Messaging
- [x] Agent → Agent communication
- [x] Message routing between agents
- [x] Shared context (optional)

---

## M4: Automation & Git ✅

### 4.1 Cron Jobs
- [x] Channel-level cron (daily standups)
- [x] Agent self-registered cron
- [x] Cron expression parser

### 4.2 Git/GitHub Tools
- [x] gh CLI wrapper
- [x] PR create/review/merge
- [x] Issue management

### 4.3 Workspace Hot-Reload
- [x] fs.watch on workspace files
- [x] Auto-reload on change

---

## M5: Daemon Mode + Web API ✅

### 5.1 Daemon Mode
- [x] `isotopes start/stop/status`
- [x] launchd (macOS) / systemd (Linux)
- [x] Log rotation

### 5.2 Web API
- [x] REST API server (Node.js built-in http)
- [x] Agent dashboard (GET /api/status, GET /api/sessions)
- [x] Session viewer (GET /api/sessions/:id, POST /api/sessions/:id/message)
- [x] Config editor (GET /api/config, PUT /api/config)
- [x] Cron management (GET/POST/DELETE /api/cron)

---

## M6: Sandbox Execution ✅

**Goal:** Secure tool execution in isolated Docker containers.

### 6.1 Sandbox Config
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

### 6.2 Docker Integration
- [x] Docker container lifecycle management
- [x] Volume mounting for workspace
- [x] Network configuration (bridge, host, none)
- [x] Resource limits (CPU, memory)

### 6.3 Sandboxed Tool Execution
- [x] Route `shell` tool through container
- [x] File operations inside container
- [x] Secure environment variable handling

### 6.4 Sandbox Image
- [x] Base image with common dev tools
- [x] `isotopes-sandbox:latest` default image
- [x] Custom image support

---

## M7: Sub-agent Backend ✅

**Goal:** Spawn external AI agents (Claude, Codex, Gemini, etc.) via Claude CLI and stream their output to Discord.

### 7.1 Claude CLI Backend
```yaml
acp:
  enabled: true
  subagent:
    defaultAgent: claude
    allowedAgents:
      - claude
      - codex
      - gemini
    timeout: 300
    maxTurns: 50
    useThread: true
    showToolCalls: true
```

- [x] AcpxBackend class wrapping `claude -p --output-format stream-json`
- [x] JSON line parsing for streaming events
- [x] Process lifecycle management (spawn, cancel, cleanup)
- [x] Support for agents: claude, codex, gemini, cursor, copilot, opencode, kimi, qwen

### 7.2 Discord Output Streaming
- [x] DiscordSink for formatting and sending events to Discord
- [x] Thread creation for sub-agent output isolation
- [x] Configurable tool call visibility
- [x] Completion summary with message/tool counts
- [x] Message truncation for Discord limits

### 7.3 SubagentManager
- [x] High-level orchestration combining AcpxBackend + DiscordSink
- [x] Task-based spawn API
- [x] Cancel support for running tasks
- [x] Error handling and graceful degradation

### 7.4 Config Integration
- [x] Sub-agent settings in ACP config section
- [x] Default agent, timeout, max turns, thread/tool-call preferences
