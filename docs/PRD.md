# 🫥 Isotopes PRD

> Version: 0.2.0 (MVP)
> Date: 2026-04-02
> Status: **Draft**

## Overview

**Isotopes** is a lightweight, self-hostable AI agent framework.

MVP scope: Multi-agent orchestration + Discord transport + GHC proxy support.

## MVP Goals

1. **Pluggable agent core** — Abstract interface, default `@openai/agents`
2. **Multi-agent management** — Create and manage agents (in-memory for MVP)
3. **Discord transport** — Basic messaging + thread streaming
4. **GHC proxy support** — `localhost:4141` as provider

## Non-Goals (MVP)

- ❌ SQLite storage → JSONL is enough for MVP
- ❌ Web UI → Future M1
- ❌ Feishu transport → Future M2
- ❌ Self-evolving prompts → Future M3
- ❌ Full ACP protocol → Simplified for MVP

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Discord Transport                    │
│  - Message handling                                     │
│  - Thread streaming                                     │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                     Orchestrator                        │
│  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │  Agent Manager  │  │  Session Store (in-memory)  │   │
│  │  (in-memory)    │  │                             │   │
│  └────────┬────────┘  └──────────────┬──────────────┘   │
│           └──────────────────────────┘                  │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│               Agent Core (Pluggable Interface)          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  interface AgentCore {                           │   │
│  │    createAgent(config): AgentInstance            │   │
│  │  }                                               │   │
│  │  ─────────────────────────────────────────────   │   │
│  │  class OpenAIAgentsCore implements AgentCore     │   │
│  │  class CustomCore implements AgentCore (future)  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                       Providers                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  GHC :4141  │  │  MiniMax    │  │  OpenAI (future)│  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Core Interfaces

### 1. Agent Core (Pluggable)

```typescript
// src/core/types.ts

/** Pluggable agent core - swap implementations without changing upper layers */
export interface AgentCore {
  createAgent(config: AgentConfig): AgentInstance;
}

export interface AgentInstance {
  /** Stream a prompt, yields events */
  prompt(input: string | Message[]): AsyncIterable<AgentEvent>;
  /** Abort current execution */
  abort(): void;
}

export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  tools?: Tool[];
  provider?: ProviderConfig;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'done'; messages: Message[] }
  | { type: 'error'; error: Error };

export interface ProviderConfig {
  type: 'ghc' | 'minimax' | 'openai';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
```

### 2. Agent Manager

```typescript
// src/orchestrator/agent-manager.ts

/** Manages agent lifecycle - MVP uses in-memory Map, extensible to persistence */
export interface AgentManager {
  create(config: AgentConfig): AgentInstance;
  get(id: string): AgentInstance | undefined;
  list(): AgentConfig[];
  update(id: string, updates: Partial<AgentConfig>): AgentInstance;
  delete(id: string): void;
}

// MVP implementation
export class InMemoryAgentManager implements AgentManager {
  private agents = new Map<string, { config: AgentConfig; instance: AgentInstance }>();
  constructor(private core: AgentCore) {}
  // ... implementation
}
```

### 3. Session Store

```typescript
// src/orchestrator/session-store.ts

/** Session storage - JSONL files with auto-cleanup */
export interface SessionStore {
  create(agentId: string, metadata?: SessionMetadata): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  delete(sessionId: string): Promise<void>;
}

export interface Session {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  lastActiveAt: Date;
}

export interface SessionMetadata {
  transport: 'discord' | 'feishu' | 'web';
  channelId?: string;
  threadId?: string;
}

export interface SessionStoreConfig {
  dataDir: string;           // e.g., './data/sessions'
  maxSessions?: number;      // default: 100
  maxTotalSizeMB?: number;   // default: 100
}

// JSONL implementation with auto-cleanup
export class JsonlSessionStore implements SessionStore {
  private sessionMeta = new Map<string, { lastActiveAt: Date; sizeBytes: number }>();

  constructor(private config: SessionStoreConfig) {}

  async addMessage(sessionId: string, message: Message): Promise<void> {
    await this.appendToFile(sessionId, message);
    this.updateMeta(sessionId);
    await this.maybeCleanup();
  }

  /** Remove oldest inactive sessions when limits exceeded */
  private async maybeCleanup(): Promise<void> {
    if (!this.shouldCleanup()) return;
    
    const sorted = [...this.sessionMeta.entries()]
      .sort((a, b) => a[1].lastActiveAt.getTime() - b[1].lastActiveAt.getTime());
    
    while (this.shouldCleanup() && sorted.length > 0) {
      const [oldestId] = sorted.shift()!;
      await this.delete(oldestId);
    }
  }
}
```

### 4. Discord Transport

```typescript
// src/transports/discord.ts

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class DiscordTransport implements Transport {
  constructor(
    private config: DiscordConfig,
    private agentManager: AgentManager,
    private sessionStore: SessionStore
  ) {}

  async start(): Promise<void>;
  async stop(): Promise<void>;

  /** Stream agent response to a Discord thread */
  async streamToThread(
    threadId: string,
    events: AsyncIterable<AgentEvent>
  ): Promise<void>;

  /** Create thread for conversation */
  async createThread(channelId: string, name: string): Promise<string>;
}
```

---

## Directory Structure (MVP)

```
isotopes/
├── src/
│   ├── core/
│   │   ├── types.ts             # AgentCore interface + types
│   │   ├── openai-agents.ts     # @openai/agents implementation
│   │   └── index.ts
│   ├── orchestrator/
│   │   ├── agent-manager.ts     # InMemoryAgentManager
│   │   ├── session-store.ts     # JsonlSessionStore + auto-cleanup
│   │   └── index.ts
│   ├── transports/
│   │   ├── types.ts             # Transport interface
│   │   ├── discord.ts           # Discord implementation
│   │   └── index.ts
│   ├── config/
│   │   ├── types.ts
│   │   └── index.ts
│   └── index.ts                 # Main entry
├── data/                        # Runtime data (gitignored)
│   ├── agents.json              # Agent configs
│   └── sessions/                # JSONL session files
│       └── {sessionId}.jsonl
├── docs/
│   └── PRD.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration (MVP)

```yaml
# config.yaml

providers:
  ghc:
    baseUrl: http://localhost:4141/v1
  minimax:
    baseUrl: https://api.minimax.chat/v1
    apiKey: ${MINIMAX_API_KEY}

defaultProvider: ghc
defaultModel: claude-sonnet-4-20250514

discord:
  token: ${DISCORD_TOKEN}

storage:
  dataDir: ./data
  maxSessions: 100       # auto-cleanup when exceeded
  maxTotalSizeMB: 100    # auto-cleanup when exceeded
  
# Agents defined in config for MVP
agents:
  - id: assistant
    name: Assistant
    systemPrompt: You are a helpful assistant.
```

---

## Line Count Estimate (MVP)

| File | Lines | Description |
|------|-------|-------------|
| core/types.ts | ~50 | Interfaces |
| core/openai-agents.ts | ~100 | @openai/agents wrapper |
| orchestrator/agent-manager.ts | ~60 | In-memory manager |
| orchestrator/session-store.ts | ~100 | JSONL storage + auto-cleanup |
| transports/discord.ts | ~200 | Discord bot + streaming |
| config/index.ts | ~80 | YAML loading |
| index.ts | ~40 | Entry point |
| **Total** | **~630** | |

---

## MVP Milestone

### M0: MVP (~2 days with Claude Code)

- [ ] Project setup (TypeScript, pnpm)
- [ ] `core/types.ts` — AgentCore interface
- [ ] `core/openai-agents.ts` — @openai/agents implementation
- [ ] `orchestrator/agent-manager.ts` — InMemoryAgentManager
- [ ] `orchestrator/session-store.ts` — JsonlSessionStore + auto-cleanup
- [ ] `transports/discord.ts` — Discord bot + thread streaming
- [ ] `config/` — YAML config loading
- [ ] `index.ts` — Main entry, wire everything
- [ ] Test with GHC proxy

### Future Milestones

| Milestone | Scope |
|-----------|-------|
| M1 | Web UI (Next.js, agent management, chat) |
| M2 | Feishu transport |
| M3 | Self-evolving prompts |
| M4 | Full ACP protocol |

---

## Extension Points

Each component is behind an interface, making future extensions easy:

| Interface | MVP Impl | Future Impl |
|-----------|----------|-------------|
| `AgentCore` | `OpenAIAgentsCore` | Custom agent loop |
| `AgentManager` | `InMemoryAgentManager` | `JsonlAgentManager` |
| `SessionStore` | `JsonlSessionStore` | `SqliteSessionStore` |
| `Transport` | `DiscordTransport` | `FeishuTransport`, `WebTransport` |

---

## Dependencies (MVP)

```json
{
  "dependencies": {
    "@openai/agents": "^0.1.0",
    "openai": "^4.70.0",
    "discord.js": "^14.0.0",
    "yaml": "^2.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^22.0.0"
  }
}
```
