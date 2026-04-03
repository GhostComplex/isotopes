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
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│                     Orchestrator                        │
│  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │  Agent Manager  │  │  Session Store (JSONL)      │   │
│  │  (JSON file)    │  │                             │   │
│  └────────┬────────┘  └──────────────┬──────────────┘   │
│           └──────────────┬───────────┘                  │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐   │
│  │                   Data Layer                     │   │
│  │  data/agents.json + data/agents/{id}/*.md        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│               Agent Core (Pluggable Interface)          │
│                                                         │
│  class PiMonoCore implements AgentCore                  │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────┐
│    Providers (OpenAI Proxy | Anthropic Proxy | Direct)  │
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
```

### AgentManager

```typescript
interface AgentManager {
  create(config: AgentConfig): Promise<AgentInstance>;
  get(id: string): AgentInstance | undefined;
  list(): AgentConfig[];
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
```

### Transport

```typescript
interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

---

## Data Structure

```
data/
├── agents.json              # Agent metadata
└── agents/{agentId}/
    ├── SOUL.md              # System prompt
    ├── TOOLS.md             # Tool instructions (optional)
    ├── MEMORY.md            # Persistent memory (optional)
    └── sessions/*.jsonl
```

---

## Directory Structure

```
isotopes/
├── src/
│   ├── core/
│   │   ├── types.ts         # AgentCore interface
│   │   └── pi-mono.ts       # Pi-Mono implementation
│   ├── orchestrator/
│   │   ├── agent-manager.ts
│   │   └── session-store.ts
│   ├── transports/
│   │   └── discord.ts
│   ├── config/
│   │   └── index.ts
│   └── index.ts
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

## Design Notes

- **Keep core layer thin** — wrapper only translates types, no heavy abstractions
- **Session auto-cleanup** — LRU eviction when limits exceeded
- **Prompts in markdown** — follows OpenClaw pattern (SOUL.md, TOOLS.md, MEMORY.md)
