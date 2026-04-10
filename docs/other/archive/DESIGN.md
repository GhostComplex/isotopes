# Isotopes - Technical Design

> Version: 0.3.0
> Date: 2026-04-08

This document describes the architecture and core interfaces of Isotopes.
For product requirements, see [PRD.md](./PRD.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Transports                            │
│    Discord         |  Feishu           |  Web API           │
│  (channels,        | (groups, P2P,     | (REST, status,     │
│   threads, DMs)    |  WebSocket)       |  sessions, cron)   │
└──────────────┬────────────────┬───────────────┬─────────────┘
               │                │               │
┌──────────────┴────────────────┴───────────────┴─────────────┐
│                      Message Router                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Binding Resolution                                 │    │
│  │  - Match by (channel, accountId, peer)              │    │
│  │  - More-specific bindings take priority             │    │
│  │  - Mention filtering (requireMention per guild)     │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │  ACP Protocol                                       │    │
│  │  - Session manager (lifecycle, Claude/Codex)        │    │
│  │  - Message bus (agent-to-agent routing)             │    │
│  │  - Shared context (cross-agent state)               │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                      Orchestrator                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │Agent Manager│  │Session Store │  │ Cron Scheduler   │   │
│  │(CRUD, prompt│  │(JSONL, key   │  │ (expression      │   │
│  │ delegation) │  │ lookup, TTL) │  │  parser, jobs)   │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│  ┌──────────────────┐  ┌──────────────────────────────┐    │
│  │Workspace Watcher │  │ Config Reloader              │    │
│  │(fs.watch, glob)  │  │ (hot-reload on file change)  │    │
│  └──────────────────┘  └──────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Context Compaction (safeguard | aggressive | off)    │   │
│  │ - Token counting, LLM-based summarization           │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│          Agent Core (Pluggable: @mariozechner/pi-*)         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  interface AgentCore {                               │   │
│  │    createAgent(config): AgentInstance                 │   │
│  │  }                                                   │   │
│  │  ─────────────────────────────────────               │   │
│  │  PiMonoCore (current implementation)                 │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Tool System                                         │   │
│  │  - ToolRegistry (register, list, invoke)             │   │
│  │  - Built-in: shell, read_file, write_file, list_dir  │   │
│  │  - Git: status, log, diff, add, commit, push, pull   │   │
│  │  - GitHub: PRs, issues, repos (via gh CLI)           │   │
│  │  - Tool guards (cli: bool, fs.workspaceOnly: bool)   │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Sandbox Executor (Docker)                           │   │
│  │  - Container lifecycle management                    │   │
│  │  - Workspace volume mounting (rw | ro)               │   │
│  │  - Per-agent mode: off | non-main | all              │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│     Providers (OpenAI Proxy | Anthropic Proxy | Direct)     │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Interfaces

### AgentCore (Pluggable)

```typescript
interface AgentCore {
  createAgent(config: AgentConfig): AgentInstance;
}

interface AgentInstance {
  prompt(input: string | Message[]): AsyncIterable<AgentEvent>;
  abort(): void;
  steer(msg: Message): void;       // Real-time user interrupt
  followUp(msg: Message): void;    // Queue follow-up after current turn
}

interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  tools?: Tool[];
  toolSettings?: AgentToolSettings;
  provider?: ProviderConfig;
  workspacePath?: string;
  compaction?: CompactionConfig;
  sandbox?: SandboxConfig;
}

type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'turn_end' }
  | { type: 'agent_end'; messages: Message[]; stopReason?: string }
  | { type: 'error'; error: Error };
```

### AgentManager

```typescript
interface AgentManager {
  create(config: AgentConfig): Promise<AgentInstance>;
  get(id: string): AgentInstance | undefined;
  list(): AgentConfig[];
  update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  getPrompt(id: string): Promise<string>;
  updatePrompt(id: string, prompt: string): Promise<void>;
}
```

### SessionStore

```typescript
interface SessionStore {
  create(agentId: string, metadata?: SessionMetadata): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  findByKey(key: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  delete(sessionId: string): Promise<void>;
}

interface SessionMetadata {
  key?: string;
  transport: 'discord' | 'feishu' | 'web';
  channelId?: string;
  threadId?: string;
}
```

### Transport

```typescript
interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

---

## Data Layout

```
~/.isotopes/
├── isotopes.yaml            # Main config
├── isotopes.pid             # Daemon PID
├── workspaces/
│   └── {agentId}/
│       ├── SOUL.md          # System prompt additions
│       ├── TOOLS.md         # Tool instructions (optional)
│       ├── MEMORY.md        # Persistent memory (optional)
│       └── sessions/
│           ├── sessions.json    # Session index
│           └── {sessionId}.jsonl
└── logs/
    └── isotopes-YYYY-MM-DD.log
```

---

## Extension Points

| Interface | Current Implementation | Purpose |
|-----------|----------------------|---------|
| `AgentCore` | `PiMonoCore` | Pluggable agent backend |
| `AgentManager` | `DefaultAgentManager` | Agent lifecycle |
| `SessionStore` | `DefaultSessionStore` | Session persistence |
| `Transport` | `DiscordTransport`, `FeishuTransport` | Message I/O |
| `ToolRegistry` | Built-in tools + user-registered | Agent capabilities |

---

## Design Principles

- **Keep core layer thin** — wrapper translates types, no heavy abstractions
- **Session auto-cleanup** — TTL-based expiration with periodic sweeps
- **Prompts in markdown** — `SOUL.md`, `TOOLS.md`, `MEMORY.md` per agent workspace
- **Config over code** — single YAML file drives multi-agent setup
- **Pluggable everything** — agent core, transports, tools, and sandbox are all swappable interfaces
