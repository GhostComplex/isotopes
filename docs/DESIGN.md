# 🫥 Isotopes - Technical Design

> Version: 0.1.0 (MVP)
> Date: 2026-04-02

This document contains detailed technical specifications for implementing Isotopes.
For product requirements and goals, see [PRD.md](./PRD.md).

---

## Architecture Diagram

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
│  │  class OpenAIAgentsCore implements AgentCore     │   │
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
  type: 'openai-proxy' | 'anthropic-proxy' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
```

### 2. Agent Manager

```typescript
// src/orchestrator/agent-manager.ts

/** Manages agent lifecycle - persisted to JSON + workspace files */
export interface AgentManager {
  create(config: AgentConfig): Promise<AgentInstance>;
  get(id: string): AgentInstance | undefined;
  list(): AgentConfig[];
  update(id: string, updates: Partial<AgentConfig>): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  
  // Prompt management (stored as markdown files)
  getPrompt(id: string): Promise<string>;
  updatePrompt(id: string, prompt: string): Promise<void>;
}

export interface AgentConfig {
  id: string;
  name: string;
  // systemPrompt is loaded from workspace/{agentId}/SOUL.md
  provider?: ProviderConfig;
  tools?: string[];
}

// Persisted implementation (similar to OpenClaw)
export class JsonAgentManager implements AgentManager {
  private agents = new Map<string, { config: AgentConfig; instance: AgentInstance }>();
  
  constructor(private core: AgentCore, private dataDir: string) {}

  async getPrompt(id: string): Promise<string> {
    const soulPath = path.join(this.dataDir, 'agents', id, 'SOUL.md');
    return fs.readFile(soulPath, 'utf-8');
  }

  async updatePrompt(id: string, prompt: string): Promise<void> {
    const soulPath = path.join(this.dataDir, 'agents', id, 'SOUL.md');
    await fs.writeFile(soulPath, prompt);
    // Recreate agent instance with new prompt
    await this.reload(id);
  }
}
```

**Data structure (following OpenClaw pattern):**
```
data/
├── agents.json              # Agent metadata only (no prompts)
└── agents/
    └── {agentId}/
        ├── SOUL.md          # System prompt (markdown)
        ├── TOOLS.md         # Tool instructions (optional)
        ├── MEMORY.md        # Persistent memory (optional)
        └── sessions/
            └── {sessionId}.jsonl
```

**agents.json** stores only metadata:
```json
[
  {
    "id": "translator",
    "name": "Translator",
    "provider": { "type": "openai-proxy", "model": "claude-sonnet-4.5" }
  }
]
```

**data/agents/translator/SOUL.md** stores the prompt:
```markdown
# Translator

You are a professional translator.

## Rules
- Translate all text to Chinese
- Preserve formatting
- Keep technical terms in English
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

## Directory Structure

```
isotopes/
├── src/
│   ├── core/
│   │   ├── types.ts             # AgentCore interface + types
│   │   ├── openai-agents.ts     # @openai/agents implementation
│   │   └── index.ts
│   ├── orchestrator/
│   │   ├── agent-manager.ts     # JsonAgentManager (persisted)
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
│   ├── agents.json              # Agent metadata (no prompts)
│   └── agents/
│       └── {agentId}/
│           ├── SOUL.md          # System prompt (markdown)
│           ├── TOOLS.md         # Tool instructions (optional)
│           ├── MEMORY.md        # Persistent memory (optional)
│           └── sessions/
│               └── {sessionId}.jsonl
├── docs/
│   ├── PRD.md
│   └── DESIGN.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## Configuration Schema

```yaml
# config.yaml

providers:
  # OpenAI-compatible proxy (ollama, vllm, copilot-api, etc.)
  openai-proxy:
    baseUrl: http://localhost:4141/v1
    apiKey: optional
    
  # Anthropic-compatible proxy
  anthropic-proxy:
    baseUrl: http://localhost:4141/v1
    apiKey: optional
    
  # Direct API access (optional)
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
  maxSessions: 100       # auto-cleanup when exceeded
  maxTotalSizeMB: 100    # auto-cleanup when exceeded
```

---

## Line Count Estimate

| File | Lines | Description |
|------|-------|-------------|
| core/types.ts | ~50 | Interfaces |
| core/openai-agents.ts | ~100 | @openai/agents wrapper |
| orchestrator/agent-manager.ts | ~80 | JSON-persisted manager |
| orchestrator/session-store.ts | ~100 | JSONL storage + auto-cleanup |
| transports/discord.ts | ~200 | Discord bot + streaming |
| config/index.ts | ~80 | YAML loading |
| index.ts | ~40 | Entry point |
| **Total** | **~650** | |

---

## Dependencies

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

---

## Post-MVP: Hooks & Plugins

### Lifecycle Hooks

```typescript
interface AgentHooks {
  onAgentStart?: (ctx: RunContext) => void;
  onTurnStart?: (ctx: RunContext, turn: number) => void;
  beforeToolCall?: (tool: Tool, args: unknown) => unknown;
  afterToolCall?: (tool: Tool, result: string) => string;
  onAgentEnd?: (ctx: RunContext, messages: Message[]) => void;
  onError?: (ctx: RunContext, error: Error) => void;
}
```

### Plugin Interface

```typescript
interface Plugin {
  name: string;
  hooks?: Partial<AgentHooks>;
  tools?: Tool[];
  transports?: Transport[];
}
```

**Built-in plugins (planned):** logging, metrics, rate limiting
