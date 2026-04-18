# Isotopes

A lightweight, self-hostable AI agent framework for multi-agent collaboration across chat platforms.

## Features

- **Multi-agent orchestration** — Multiple agents with distinct personas, each with its own workspace
- **Self-evolving prompts** — Agents can update their own system prompts via `SOUL.md` and `MEMORY.md`
- **Binding-based routing** — Route messages to agents by channel, account, and peer with priority resolution
- **Transports** — Discord (channels, threads, DMs) and Feishu (groups, P2P, WebSocket)
- **ACP** — Agent Communication Protocol for inter-agent messaging and shared context
- **Git/GitHub tools** — Built-in `gh` CLI wrapper for PRs, issues, and repo management
- **Cron automation** — Scheduled tasks with cron expressions (daily standups, periodic prompts)
- **Daemon mode** — Background process with `start`/`stop`/`status`, plus launchd/systemd service install
- **Web API** — REST endpoints for status, sessions, config, and cron management
- **Sandbox execution** — Isolate tool execution in Docker containers with workspace mounting
- **Context compaction** — LLM-based summarization to manage context window size
- **Workspace hot-reload** — Auto-reload agent config and prompts on file changes
- **Local-first** — Everything runs on your machine

## Quick Start (from source)

```bash
# Clone the repo
git clone https://github.com/GhostComplex/isotopes.git
cd isotopes

# Install dependencies
pnpm install

# Build
pnpm build

# Create config
mkdir -p ~/.isotopes
cp isotopes.example.yaml ~/.isotopes/isotopes.yaml
# Edit ~/.isotopes/isotopes.yaml with your settings

# Run in foreground
node dist/cli.js

# Or run as daemon
node dist/cli.js start
node dist/cli.js status
node dist/cli.js stop
```

## CLI

```
isotopes                           Run in foreground (default)
isotopes start [--config path]     Start as background daemon
isotopes stop                      Stop the running daemon
isotopes status                    Show daemon status
isotopes restart [--config path]   Restart the daemon

isotopes service install           Install as system service (launchd/systemd)
isotopes service uninstall         Remove system service
isotopes service enable            Enable service (auto-start on boot)
isotopes service disable           Disable service

Options:
  -h, --help       Show help
  -v, --version    Show version
  -c, --config     Path to config file
```

## Configuration

```yaml
# ~/.isotopes/isotopes.yaml

provider:
  type: anthropic                    # anthropic | openai | openai-proxy | anthropic-proxy
  model: claude-sonnet-4-20250514
  apiKey: ${ANTHROPIC_API_KEY}

tools:
  cli: false                         # Shell execution (default: off)
  fs:
    workspaceOnly: true              # Restrict file tools to workspace

agents:
  - id: assistant
    name: Assistant
    # tools:                         # Per-agent tool overrides
    #   cli: true
    # compaction:
    #   mode: safeguard              # off | safeguard | aggressive
    # sandbox:
    #   mode: non-main              # off | non-main | all

discord:
  tokenEnv: DISCORD_TOKEN
  defaultAgentId: assistant

# See isotopes.example.yaml for full options including:
# - Agent bindings (channel + account + peer routing)
# - Feishu transport
# - ACP protocol
# - Cron jobs
# - Sandbox/Docker config
```

See [isotopes.example.yaml](isotopes.example.yaml) for all options.

### API key & base URL resolution

Isotopes has **two independent consumers** of credentials, each with its own
lookup path:

**Main agent (`PiMonoCore`)** — reads `provider.apiKey` / `provider.baseUrl`
from yaml only. Yaml supports `${VAR}` interpolation against `process.env`:

```yaml
provider:
  type: anthropic-proxy
  apiKey: ${ANTHROPIC_API_KEY}      # or a literal string
  baseUrl: ${ANTHROPIC_BASE_URL}    # optional, defaults to api.anthropic.com
```

**Subagent SDK (`@anthropic-ai/claude-agent-sdk`)** — reads `process.env`
directly: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_BASE_URL`. The backend does not pass them explicitly; the SDK looks
them up itself.

**`process.env` is populated in this order** (highest priority first):

1. Shell exports / launchd `EnvironmentVariables` / systemd `Environment=`
2. `.env.local` at the project root (auto-loaded on startup)
3. `~/.claude/settings.json`'s `env` block (auto-loaded; only fills keys not
   already set — override the path with `CLAUDE_SETTINGS_PATH=...`)

Recommended setup: put the credential in env (any of the three sources above),
then write `${ANTHROPIC_API_KEY}` / `${ANTHROPIC_BASE_URL}` in yaml. Both the
main agent and the subagent will pick up the same value automatically.

If you write the apiKey as a literal string in yaml, only the main agent gets
it — the subagent will 401 unless the env var is also set.

### Reusing Claude Code's settings.json

If you already use Claude Code, the auto-loader above lets isotopes inherit
your existing endpoint and token without duplication:

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-proxy.example.com",
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

### Tool Guards

```yaml
tools:
  cli: false                         # Global default: no shell
  fs:
    workspaceOnly: true              # Global default: workspace-only files

agents:
  - id: dev-agent
    tools:
      cli: true                      # This agent CAN run shell commands
```

- `tools.cli` — enables shell/CLI command execution. Default: `false`.
- `tools.fs.workspaceOnly` — restricts file tools to the agent workspace. Default: `true`.
- `agents[].tools` — overrides the global defaults for a single agent.

## Programmatic API

Isotopes exports a full TypeScript API for building custom integrations:

### Create and prompt an agent

```typescript
import {
  PiMonoCore,
  DefaultAgentManager,
  DefaultSessionStore,
  ToolRegistry,
  createTimeTool,
} from "isotopes";

// Set up core + manager
const core = new PiMonoCore();
const manager = new DefaultAgentManager(core);

// Register tools
const tools = new ToolRegistry();
tools.register(...createTimeTool());
core.setToolRegistry("my-agent", tools);

// Create an agent
const agent = await manager.create({
  id: "my-agent",
  name: "My Agent",
  systemPrompt: "You are a helpful assistant.",
  provider: {
    type: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-4-20250514",
  },
});

// Stream a response
for await (const event of agent.prompt("What time is it?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

### Session management

```typescript
import { DefaultSessionStore } from "isotopes";

const store = new DefaultSessionStore({ dataDir: "./sessions" });
await store.init();

// Create a session and add messages
const session = await store.create("my-agent", {
  transport: "web",
  key: "user:123",
});
await store.addMessage(session.id, {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
});

// Retrieve by key
const found = await store.findByKey("user:123");
```

### Git/GitHub tools

```typescript
import { gitStatus, gitLog, createPR, listIssues } from "isotopes";

const status = await gitStatus({ cwd: "/path/to/repo" });
const log = await gitLog({ cwd: "/path/to/repo", maxCount: 5 });

const pr = await createPR({
  title: "Add feature",
  body: "Description here",
  head: "feat/my-feature",
  base: "main",
});

const issues = await listIssues({ state: "open" });
```

### Cron scheduling

```typescript
import { CronScheduler, parseCronExpression } from "isotopes";

const scheduler = new CronScheduler();

scheduler.add({
  id: "daily-standup",
  schedule: parseCronExpression("0 9 * * 1-5"),
  action: { type: "message", content: "Time for standup!" },
  callback: (job) => console.log(`Fired: ${job.id}`),
});

scheduler.start();
```

## Directory Layout

```
~/.isotopes/
├── isotopes.yaml            # Main config file
├── isotopes.pid             # Daemon PID file
├── workspaces/
│   └── {agentId}/
│       ├── SOUL.md          # Agent personality / system prompt
│       ├── TOOLS.md         # Tool instructions (optional)
│       ├── MEMORY.md        # Persistent memory (optional)
│       └── sessions/
│           ├── sessions.json    # Session index
│           └── {sessionId}.jsonl
└── logs/
    └── isotopes-YYYY-MM-DD.log
```

Override the base directory with `ISOTOPES_HOME` environment variable.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Transports                            │
│    Discord Transport  |  Feishu Transport  |  Web API       │
└──────────────┬────────────────┬───────────────┬─────────────┘
               │                │               │
┌──────────────┴────────────────┴───────────────┴─────────────┐
│                      Message Router                         │
│   - Binding resolution (channel + account + peer)           │
│   - Mention filtering (requireMention per guild/group)      │
│   - ACP protocol + inter-agent messaging                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                      Orchestrator                           │
│  Agent Manager  +  Session Store  +  Cron Scheduler         │
│  Workspace Watcher  +  Config Reloader  +  Compaction       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│          Agent Core (Pluggable: @mariozechner/pi-*)         │
│       Tool System  +  Sandbox Executor (Docker)             │
│       Git/GitHub Tools  +  File/Shell Tools                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│     Providers (OpenAI Proxy | Anthropic Proxy | Direct)     │
└─────────────────────────────────────────────────────────────┘
```

## Logging

```bash
LOG_LEVEL=debug isotopes        # debug | info | warn | error (default: info)
DEBUG=isotopes isotopes         # Alternative debug flag
```

## Development

```bash
git clone https://github.com/GhostComplex/isotopes
cd isotopes
pnpm install

pnpm build                     # Compile TypeScript
pnpm dev                       # Run without building (tsx)
pnpm test                      # Unit tests (vitest)
pnpm test:watch                # Watch mode
pnpm lint                      # ESLint
pnpm typecheck                 # TypeScript type checking
pnpm ci                        # lint + typecheck + test
```

### Integration Tests

```bash
export DISCORD_TOKEN="your-bot-token"
export DISCORD_TEST_CHANNEL="channel-id"
export ANTHROPIC_API_KEY="sk-ant-..."
pnpm test:integration
```

See [tests/integration/README.md](tests/integration/README.md) for setup details.

### Project Structure

```
src/
├── core/               # Core components
│   ├── types.ts            # All framework interfaces and types
│   ├── pi-mono.ts          # Pi-Mono agent wrapper
│   ├── agent-manager.ts    # Agent lifecycle management
│   ├── agent-runner.ts     # Agent execution loop
│   ├── session-store.ts    # JSONL session persistence
│   ├── session-keys.ts     # Session key generation
│   ├── tools.ts            # Tool registry and built-in tools
│   ├── workspace.ts        # Workspace context loading (SOUL/TOOLS/MEMORY)
│   ├── bindings.ts         # Message-to-agent routing
│   ├── thread-bindings.ts  # Discord thread auto-binding
│   ├── mention.ts          # @mention detection
│   ├── compaction.ts       # Context window compaction
│   ├── config.ts           # YAML config loader + validation
│   ├── paths.ts            # Path resolution (~/.isotopes/...)
│   └── logger.ts           # Structured logging
├── transports/         # Transport implementations
│   ├── discord.ts          # Discord (channels, threads, DMs)
│   └── feishu.ts           # Feishu/Lark (groups, P2P, WebSocket)
├── acp/                # Agent Communication Protocol
│   ├── session-manager.ts  # ACP session lifecycle
│   ├── message-bus.ts      # Inter-agent message routing
│   └── shared-context.ts   # Shared context between agents
├── automation/         # Scheduled tasks
│   ├── cron-parser.ts      # Cron expression parsing
│   └── cron-job.ts         # Job scheduler
├── tools/              # Extended tool implementations
│   ├── git.ts              # Git CLI wrapper
│   └── github.ts           # GitHub CLI wrapper (PRs, issues)
├── api/                # Web API
│   ├── server.ts           # HTTP server (Node built-in)
│   ├── routes.ts           # REST endpoints
│   └── middleware.ts       # Request handling
├── daemon/             # Background process management
│   ├── process.ts          # PID-based daemon lifecycle
│   ├── service.ts          # launchd/systemd integration
│   └── log-rotation.ts     # Log file rotation
├── sandbox/            # Sandboxed execution
│   ├── config.ts           # Sandbox configuration
│   ├── container.ts        # Docker container management
│   └── executor.ts         # Sandboxed tool execution
├── workspace/          # Workspace file watching
│   ├── watcher.ts          # File system watcher
│   └── config-reloader.ts  # Hot-reload on config changes
├── cli.ts              # CLI entry point
└── index.ts            # Public API exports
```

## Documentation

- [PRD](docs/PRD.md) — Product Requirements Document
- [Design](docs/DESIGN.md) — Technical Design Document

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes with tests
4. Run `pnpm ci` to verify
5. Commit with conventional commits (`feat:`, `fix:`, `docs:`, etc.)
6. Open a PR

## License

MIT
