# Isotopes Architecture

Last updated: 2026-04-24

## Overview

Isotopes is a self-hostable AI agent framework for multi-agent collaboration across chat platforms. This document describes the system architecture across all 13 source modules.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    CLI  (src/cli.ts)                                    │
│  parseArgs → subcommand dispatch                                                        │
├────────┬──────────┬──────────┬───────────┬──────────┬───────────────────────────────────┤
│ start  │  stop    │ status   │ sessions  │  tui     │  (no subcommand = foreground)     │
│ restart│          │          │ cron/logs │          │           ↓                        │
│   ↓    │          │          │   ↓       │   ↓      │     loadConfig()                  │
│ Daemon │          │          │ REST API  │ TUI app  │     createRuntime()               │
│Process │          │          │  client   │          │           ↓                        │
└────┬───┴──────────┴──────────┴───────────┴──────────┴───────────┬───────────────────────┘
     │                                                            │
     │  spawn detached node process                               │
     │  PID file + log redirect                                   │
     ▼                                                            ▼
┌──────────────────────┐                    ┌─────────────────────────────────────────────┐
│   Daemon (daemon/)   │                    │            Runtime  (core/runtime.ts)       │
│                      │                    │                                             │
│  DaemonProcess       │                    │  Orchestrates all subsystems:               │
│  ├─ start/stop/      │◄───────────────────│                                             │
│  │  status/restart   │  same entry point  │  1. PluginManager                           │
│  │                   │  w/ ISOTOPES_DAEMON│  2. SessionStoreManager                     │
│  ServiceManager      │                    │  3. PiMonoCore                              │
│  ├─ launchd (macOS)  │                    │  4. DefaultAgentManager                     │
│  ├─ systemd (Linux)  │                    │  5. SubagentBackend                         │
│  └─ schtasks (Win)   │                    │  6. SandboxExecutor                         │
│                      │                    │  7. Agent init loop ──────┐                 │
│  LogRotation         │                    │  8. HotReloadManager     │                  │
└──────────────────────┘                    │  9. HeartbeatManager(s)  │                  │
                                            │ 10. CronScheduler       │                  │
                                            │ 11. Transports           │                  │
                                            │ 12. ApiServer            │                  │
                                            └──────────────────────────┼──────────────────┘
                                                                       │
     ┌─────────────────────────────────────────────────────────────────┘
     ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                           Agent Initialization  (core/agent-init.ts)                     │
│                                                                                          │
│  For each agent in config:                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ 1. toAgentConfig()  ─── merge agent > defaults > global                             │ │
│  │ 2. resolveWorkspace() → seed templates (SOUL.md, TOOLS.md, etc.)                   │ │
│  │ 3. loadWorkspaceContext() → read SOUL/IDENTITY/USER/TOOLS/AGENTS/BOOTSTRAP/MEMORY   │ │
│  │ 4. loadSkills() → scan workspace/skills/ + bundled skills                           │ │
│  │ 5. buildSystemPrompt() → combine all context into system prompt                     │ │
│  │ 6. Create ToolRegistry → register tools based on policy                             │ │
│  │ 7. core.setToolRegistry() → agentManager.create()                                  │ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                  Core Layer  (src/core/)                                 │
│                                                                                          │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────────────────────────┐ │
│  │  Config          │  │ AgentManager     │  │  PiMonoCore  (AgentCore impl)           │ │
│  │  (config.ts)     │  │ (agent-manager)  │  │  (pi-mono.ts)                           │ │
│  │                  │  │                  │  │                                          │ │
│  │  YAML/JSON load  │  │  In-memory       │  │  Wraps @mariozechner/pi-coding-agent    │ │
│  │  Zod validation  │  │  agent registry  │  │                                          │ │
│  │  ${ENV} interp   │  │  id → AgentEntry │  │  AgentServiceCache (per-agent):          │ │
│  │                  │  │  (config, cache,  │  │  ├─ resolved Model                      │ │
│  │                  │  │   workspace ctx,  │  │  ├─ ToolDefinition[]                    │ │
│  │                  │  │   system prompt)  │  │  ├─ compaction config                   │ │
│  └─────────────────┘  │                  │  │  └─ createSession() → AgentSession       │ │
│                        │  create/get/     │  │                                          │ │
│                        │  update/delete/  │  │  Model resolution:                       │ │
│                        │  reloadWorkspace │  │  anthropic/openai/proxied providers      │ │
│  ┌─────────────────┐  └──────────────────┘  └──────────────────────────────────────────┘ │
│  │  Bindings        │                                                                    │
│  │  (bindings.ts)   │  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  │  │  ToolRegistry  (tools.ts)                                    │  │
│  │  Routes msgs to  │  │                                                              │  │
│  │  agents by:      │  │  Per-agent tool set:   Built-in tools:                       │  │
│  │  (channel,       │  │  name → (schema,       ├─ echo, get_current_time             │  │
│  │   accountId,     │  │         handler)        ├─ read_file, write_file, edit, ls    │  │
│  │   peer)          │  │                         ├─ exec (shell), process_list/kill    │  │
│  │                  │  │  Tool guards:           ├─ web_fetch, web_search              │  │
│  │  Priority:       │  │  ├─ CLI allow/deny      ├─ spawn_subagent                     │  │
│  │  ch+acct+peer    │  │  └─ FS allow/deny       └─ message_react, message_reply       │  │
│  │  > ch+acct       │  │                                                              │  │
│  │  > ch only       │  │  Plugin hooks: before_tool_call / after_tool_call            │  │
│  └─────────────────┘  └──────────────────────────────────────────────────────────────┘  │
│                                                                                          │
│  ┌──────────────────────────────┐  ┌──────────────────────────────────────────────────┐  │
│  │  SessionStore                │  │  Workspace  (workspace.ts)                       │  │
│  │  (session-store.ts)          │  │                                                  │  │
│  │                              │  │  Context files → system prompt:                  │  │
│  │  sessions.json (index)       │  │  ├─ SOUL.md        (personality)                 │  │
│  │  + per-session .jsonl        │  │  ├─ IDENTITY.md    (identity)                    │  │
│  │                              │  │  ├─ USER.md        (user context)                │  │
│  │  create/get/findByKey        │  │  ├─ TOOLS.md       (tool guidance)               │  │
│  │  addMessage/getMessages      │  │  ├─ AGENTS.md      (multi-agent)                 │  │
│  │  TTL-based cleanup           │  │  ├─ BOOTSTRAP.md   (bootstrap)                   │  │
│  │                              │  │  ├─ MEMORY.md      (long-term memory)            │  │
│  │  SessionStoreManager:        │  │  ├─ memory/*.md    (daily memory files)          │  │
│  │  per-agent store cache       │  │  └─ skills/        (skill definitions)           │  │
│  └──────────────────────────────┘  └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
     │                       │                              │
     │  session mgmt         │  agent lookup                │  prompt + tools
     ▼                       ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                        Agent Runner  (core/agent-runner.ts)                               │
│                                                                                          │
│  startAgentLoop(agentId, sessionStore, input, callbacks):                                │
│    1. cache.createSession({ sessionManager, systemPrompt, cwd })                         │
│    2. session.prompt(textInput)                                                          │
│    3. Subscribe to AgentSessionEvents:                                                   │
│       ┌──────────────────────────────────────────────────────────────────────┐            │
│       │  message_update  ──→ text_delta ──→ onTextDelta callback            │            │
│       │  tool_exec_start ──→ log + onToolEvent                              │            │
│       │  tool_exec_end   ──→ log + onToolEvent                              │            │
│       │  turn_end        ──→ track usage, steer (drain pending messages)    │            │
│       │  agent_end       ──→ extract stopReason, resolve promise            │            │
│       └──────────────────────────────────────────────────────────────────────┘            │
│    4. Return { responseText, usage, stopReason }                                         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
     │                                         ▲
     │  events stream up                       │  messages flow down
     ▼                                         │
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              Transports  (src/transports/)                                │
│                                                                                          │
│  ┌────────────────────────────────────┐  ┌────────────────────────────────────────────┐  │
│  │  Discord Transport                 │  │  Feishu Transport                          │  │
│  │  (discord.ts + discord-manager.ts) │  │  (feishu.ts)                               │  │
│  │                                    │  │                                            │  │
│  │  Multi-account support             │  │  Groups + P2P                              │  │
│  │  Channels, threads, DMs            │  │  WebSocket connection                      │  │
│  │  @mention handling                 │  │  Binding resolution                        │  │
│  │  Image attachments (send/recv)     │  │  Message chunking                          │  │
│  │  SegmentedStreamBuffer             │  │                                            │  │
│  │  SlashCommandHandler               │  │  Active session concurrency gate           │  │
│  │  ThreadBindingManager              │  │                                            │  │
│  │  DiscordSubagentSink               │  │                                            │  │
│  │                                    │  │                                            │  │
│  │  Message flow:                     │  │                                            │  │
│  │  handleMessage()                   │  │                                            │  │
│  │   → shouldRespond()               │  │                                            │  │
│  │   → resolveAgentId()              │  │                                            │  │
│  │   → findOrCreateSession()         │  │                                            │  │
│  │   → startAgentLoop()             │  │                                            │  │
│  │   → stream response to channel    │  │                                            │  │
│  └────────────────────────────────────┘  └────────────────────────────────────────────┘  │
│                                                                                          │
│  + Plugin-registered transports via PluginManager.registerTransport()                    │
└──────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              Subagent System  (src/subagent/)                             │
│                                                                                          │
│  SubagentBackend (backend.ts) ── dispatcher, max 5 concurrent                            │
│       │                                                                                  │
│       ├──→ ClaudeRunner  (runners/claude.ts)                                             │
│       │    Claude Agent SDK: query() → SDKMessage stream → SubagentEvent                 │
│       │    Permission modes: skip | allowlist | default                                   │
│       │                                                                                  │
│       └──→ BuiltinRunner  (runners/builtin.ts)                                           │
│            In-process via PiMonoCore, filtered tools (no write/web/subagent)              │
│                                                                                          │
│  SubagentEvent: start → message → tool_use → tool_result → done | error                 │
│                                                                                          │
│  DiscordSink: streams subagent output to Discord thread                                  │
│  TaskRegistry: tracks active subagent tasks                                              │
│  FailureTracker: rate-limits repeated failures                                           │
│  Persistence: JSONL transcript storage                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────┐  ┌──────────────────────┐  ┌──────────────────────────────┐
│  Automation (automation/)   │  │  API Server (api/)   │  │  Sandbox (sandbox/)          │
│                             │  │                      │  │                              │
│  CronScheduler              │  │  Node http server    │  │  ContainerManager            │
│  ├─ croner-based            │  │  port 2712           │  │  ├─ docker create/exec/      │
│  ├─ per-agent + global jobs │  │                      │  │  │  start/stop/remove        │
│  └─ trigger → agentLoop()   │  │  Routes:             │  │  ├─ volume mounts            │
│                             │  │  /api/status         │  │  ├─ resource limits           │
│  HeartbeatManager           │  │  /api/sessions       │  │  └─ capability hardening      │
│  ├─ reads HEARTBEAT.md      │  │  /api/cron           │  │                              │
│  ├─ periodic agent wakeup   │  │  /api/config         │  │  SandboxExecutor             │
│  └─ suppresses NO_REPLY     │  │  /api/logs           │  │  ├─ per-agent container      │
│                             │  │  /api/usage          │  │  └─ lazy creation            │
│                             │  │  /api/subagents      │  │                              │
│                             │  │  /api/chat/* (SSE)   │  │  SandboxFs                   │
│                             │  │  /ui/* (plugins)     │  │  └─ routes fs ops through    │
│                             │  │                      │  │     docker exec              │
│                             │  │  Middleware:          │  │                              │
│                             │  │  auth + CORS         │  │                              │
└─────────────────────────────┘  └──────────────────────┘  └──────────────────────────────┘

┌─────────────────────────────┐  ┌──────────────────────┐  ┌──────────────────────────────┐
│  Workspace (workspace/)     │  │  Skills (skills/)    │  │  Plugins (plugins/)          │
│                             │  │                      │  │                              │
│  WorkspaceWatcher           │  │  SkillDiscovery      │  │  PluginManager               │
│  ├─ fs.watch on workspace   │  │  ├─ scans dirs for   │  │  ├─ discovers plugins        │
│  └─ debounced change events │  │  │  SKILL.md files   │  │  ├─ loads entry modules      │
│                             │  │  │                   │  │  └─ calls register(api)      │
│  HotReloadManager           │  │  SkillParser         │  │                              │
│  ├─ watches SOUL/MEMORY/    │  │  └─ extracts meta    │  │  Plugin API surface:         │
│  │  skills/ per agent       │  │                      │  │  ├─ registerTransport()      │
│  └─ triggers reloadWorkspace│  │  SkillLoader         │  │  ├─ registerUI()             │
│                             │  │  └─ generatePrompt() │  │  ├─ registerTool()           │
│  ConfigReloader             │  │     → XML block in   │  │  └─ on(hook, handler)        │
│  └─ watches isotopes.yaml   │  │       system prompt  │  │                              │
│                             │  │                      │  │  Hooks: before_agent_start,  │
│  Templates                  │  │  Bundled skills in   │  │  agent_end, before/after     │
│  └─ seed default workspace  │  │  package + workspace │  │  tool_call, message_*,       │
│     files on first init     │  │  + ~/.isotopes/skills│  │  session_start/end           │
└─────────────────────────────┘  └──────────────────────┘  └──────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                           External Dependencies                                         │
│                                                                                          │
│  @mariozechner/pi-coding-agent  ── AgentSession, SessionManager, createAgentSession()    │
│  @mariozechner/pi-agent-core    ── AgentMessage, AgentEvent types                        │
│  @mariozechner/pi-ai            ── Model definitions, getModel()                         │
│  @anthropic-ai/claude-agent-sdk ── query(), SDKMessage (for ClaudeRunner)                │
│  discord.js                     ── Discord client                                        │
│  croner                         ── Cron expression parsing                               │
│  yaml / zod                     ── Config parsing & validation                           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

The core message path:

```
Chat Platform (Discord/Feishu)
       │
       │  incoming message
       ▼
  Transport.handleMessage()
       │
       ├─ shouldRespond()         filter: DM policy, mentions, dedup, debounce
       ├─ resolveAgentId()        via @mention bindings or defaultAgentId
       ├─ findOrCreateSession()   key = transport:botId:channel:channelId:agentId
       │
       ▼
  Agent Runner.startAgentLoop()
       │
       ├─ AgentServiceCache.createSession()    (from PiMonoCore)
       ├─ session.prompt(input)
       │
       ▼
  AgentSession event stream
       │
       ├─ message_update ──→ text_delta ──→ streamed back to chat platform
       ├─ tool_exec_start/end ──→ ToolRegistry.handler() ──→ tool result
       ├─ turn_end ──→ usage tracking, steer (inject pending messages)
       └─ agent_end ──→ final response
```

## Module Summary

| Module | Directory | Key Files | Purpose |
|--------|-----------|-----------|---------|
| CLI | `src/` | `cli.ts` | Entry point, subcommand dispatch |
| Core | `src/core/` | `runtime.ts`, `pi-mono.ts`, `agent-manager.ts`, `tools.ts`, `bindings.ts`, `session-store.ts`, `config.ts`, `workspace.ts` | Framework kernel |
| Transports | `src/transports/` | `discord.ts`, `feishu.ts`, `discord-manager.ts` | Chat platform adapters |
| Subagent | `src/subagent/` | `backend.ts`, `runners/claude.ts`, `runners/builtin.ts` | Sub-agent spawning |
| API | `src/api/` | `server.ts`, `routes.ts`, `middleware.ts` | REST API + SSE chat |
| Daemon | `src/daemon/` | `process.ts`, `service.ts`, `log-rotation.ts` | Background process management |
| Automation | `src/automation/` | `cron-job.ts`, `heartbeat.ts` | Scheduled tasks |
| Sandbox | `src/sandbox/` | `container.ts`, `executor.ts`, `fs-bridge.ts` | Docker-based isolation |
| Workspace | `src/workspace/` | `watcher.ts`, `hot-reload.ts`, `templates.ts` | File watching + hot reload |
| Skills | `src/skills/` | `discovery.ts`, `parser.ts`, `loader.ts` | Skill discovery + injection |
| Plugins | `src/plugins/` | `manager.ts`, `hook-registry.ts`, `ui-registry.ts` | Plugin system |
| Tools | `src/tools/` | `git.ts`, `github.ts`, `exec.ts`, `web.ts`, `subagent.ts` | Tool implementations |
| Commands | `src/commands/` | `slash-commands.ts` | Discord slash commands |
