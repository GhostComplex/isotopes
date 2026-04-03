# 🫥 Isotopes - Technical Design

> Version: 0.1.0 (MVP)
> Date: 2026-04-03

This document contains architecture and interface specifications for Isotopes.
For product requirements, see [PRD.md](./PRD.md).

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
│  │  Agent Manager  │  │  Session Store (JSONL)      │   │
│  │  (JSON file)    │  │                             │   │
│  └────────┬────────┘  └──────────────┬──────────────┘   │
│           │                          │                  │
│           ▼                          ▼                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │                   Data Layer                     │   │
│  │  data/                                           │   │
│  │  ├── agents.json        (agent metadata)         │   │
│  │  └── agents/{id}/                                │   │
│  │      ├── SOUL.md        (system prompt)          │   │
│  │      ├── TOOLS.md       (tool instructions)      │   │
│  │      ├── MEMORY.md      (persistent memory)      │   │
│  │      └── sessions/*.jsonl                        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│               Agent Core (Pluggable Interface)          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  interface AgentCore {                           │   │
│  │    createAgent(config): AgentInstance            │   │
│  │  }                                               │   │
│  │  ─────────────────────────────────────────────   │   │
│  │  class PiMonoCore implements AgentCore           │   │
│  │  class CustomCore implements AgentCore (future)  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                   Providers (External)                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │OpenAI Proxy │  │Anthropic   │  │  Direct APIs    │  │
│  │(ollama,etc) │  │   Proxy    │  │ (OpenAI, etc.)  │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
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
  steer(msg: Message): void;
  followUp(msg: Message): void;
}

interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  tools?: Tool[];
  provider?: ProviderConfig;
}

type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'turn_end' }
  | { type: 'agent_end'; messages: Message[] }
  | { type: 'error'; error: Error };

interface ProviderConfig {
  type: 'openai-proxy' | 'anthropic-proxy' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
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
  addMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  delete(sessionId: string): Promise<void>;
}

interface Session {
  id: string;
  agentId: string;
  metadata?: SessionMetadata;
  lastActiveAt: Date;
}

interface SessionMetadata {
  transport: 'discord' | 'feishu' | 'web';
  channelId?: string;
  threadId?: string;
}

interface SessionStoreConfig {
  dataDir: string;
  maxSessions?: number;      // default: 100
  maxTotalSizeMB?: number;   // default: 100
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

## Directory Structure

```
isotopes/
├── src/
│   ├── core/
│   │   ├── types.ts         # AgentCore interface + types
│   │   └── pi-mono.ts       # Pi-Mono implementation
│   ├── orchestrator/
│   │   ├── agent-manager.ts # JsonAgentManager
│   │   └── session-store.ts # JsonlSessionStore
│   ├── transports/
│   │   └── discord.ts       # Discord transport
│   ├── config/
│   │   └── index.ts         # YAML loader
│   └── index.ts             # Main entry
├── data/                    # Runtime data (gitignored)
├── docs/
└── package.json
```

---

## Configuration

```yaml
providers:
  openai-proxy:
    baseUrl: http://localhost:4141/v1
    apiKey: optional
  anthropic-proxy:
    baseUrl: http://localhost:4141/v1
    apiKey: optional
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

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

## Design Notes

- **Keep core layer thin** — wrapper only translates types, no heavy abstractions or tight coupling with Pi-Mono
- **Session auto-cleanup** — LRU eviction when limits exceeded
- **Prompts in markdown** — follows OpenClaw pattern (SOUL.md, TOOLS.md, MEMORY.md)
