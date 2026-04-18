# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Isotopes is a self-hostable AI agent framework for multi-agent collaboration across chat platforms (Discord, Feishu). Agents have self-evolving prompts (SOUL.md, MEMORY.md), binding-based message routing, ACP inter-agent messaging, cron automation, sandbox execution, and daemon mode.

## Commands

```bash
pnpm install           # Install dependencies (pnpm is canonical, not npm)
pnpm build             # Compile TypeScript (plain tsc -> dist/)
pnpm dev               # Run without building (tsx src/cli.ts)
pnpm lint              # ESLint
pnpm lint:fix          # ESLint with auto-fix
pnpm typecheck         # tsc --noEmit
pnpm test              # Vitest (unit tests only, excludes integration/)
pnpm test:watch        # Vitest in watch mode
pnpm ci                # lint + typecheck + test (full local validation)

# Single test file
npx vitest run src/core/tools.test.ts

# Single test by name
npx vitest run -t "registers a tool"

# Integration tests (requires DISCORD_TOKEN + DISCORD_TEST_CHANNEL env vars)
pnpm test:integration
```

## Architecture

**Module resolution**: ESM-only (`"type": "module"`). All imports use `.js` extensions (NodeNext resolution). Target: ES2022. Node >= 20.

### Core (`src/core/`)
- `types.ts` — Framework-wide interfaces (Message, Tool, AgentConfig, AgentInstance, AgentCore, Transport, Binding, Session, SessionStore). Zero coupling to any specific SDK.
- `pi-mono.ts` — `PiMonoCore`: the default AgentCore implementation wrapping `@mariozechner/pi-agent-core`. Handles model resolution, tool bridging, context compaction.
- `agent-manager.ts` — `DefaultAgentManager`: in-memory agent registry with workspace awareness.
- `tools.ts` — `ToolRegistry` class + built-in tools (echo, time, shell, file read/write, list dir, subagent). Tool guards enforce CLI/FS access.
- `bindings.ts` — Routes messages to agents by (channel, accountId, peer) with priority scoring.
- `workspace.ts` — Loads workspace context files (SOUL.md, TOOLS.md, MEMORY.md, BOOTSTRAP.md) into system prompts.
- `compaction.ts` — LLM-based context window summarization.
- `session-store.ts` — In-memory sessions with JSONL file persistence.
- `config.ts` — YAML config loader with Zod validation. Supports `${ENV_VAR}` interpolation.
- `test-helpers.ts` — Shared mock factories: `createMockAgentInstance()`, `createMockAgentManager()`, `createMockSessionStore()`.

### Transports (`src/transports/`)
- `discord.ts` — Discord transport (channels, threads, DMs, mention handling, binding resolution).
- `feishu.ts` — Feishu/Lark transport (groups, P2P, WebSocket).

### Tools (`src/tools/`)
- `git.ts` / `github.ts` — Git and `gh` CLI wrappers.
- `subagent.ts` — Subagent spawning and management.

### Other modules
- `src/acp/` — Agent Communication Protocol: session management, message bus, shared context.
- `src/automation/` — Cron expression parsing and job scheduling.
- `src/api/` — REST API using raw Node `http` (no Express).
- `src/daemon/` — PID-based daemon lifecycle, launchd/systemd service integration, log rotation.
- `src/sandbox/` — Docker container management for sandboxed tool execution.
- `src/workspace/` — File watcher, hot-reload manager, workspace templates and state.
- `src/skills/` — Skill discovery, parsing, and prompt injection.
- `src/subagent/` — Sub-agent management via the Claude Agent SDK, Discord sink for output routing.
- `src/iteration/` — Self-iteration planning, execution, reporting, validation.
- `src/cli.ts` — CLI entry point. Parses args, dispatches subcommands or runs foreground.

### Key patterns
- **Pluggable core**: `AgentCore` is an interface; `PiMonoCore` is the default. Swap the LLM backend without touching the rest.
- **Tool registry**: Tools are `(schema, handler)` pairs. Tool guards (CLI, FS) are enforced at registration and injected into system prompts.
- **Event streaming**: `AgentInstance.prompt()` returns `AsyncIterable<AgentEvent>` — discriminated union of turn_start, text_delta, tool_call, tool_result, turn_end, agent_end, error.
- **Binding resolution**: More-specific bindings win (channel+account+peer > channel+account > channel).
- **AsyncLocalStorage context**: `SubagentDiscordContext` passes Discord-specific context through async chains.
- **Workspace context**: SOUL.md/TOOLS.md/MEMORY.md/BOOTSTRAP.md are merged into system prompts and hot-reloaded on change.

## Testing

- Framework: Vitest with `globals: true`
- Tests are co-located with source files (`.test.ts` suffix in same directory)
- Additional tests in `tests/` (top-level)
- Mock helpers in `src/core/test-helpers.ts`
- Integration tests in `tests/integration/` are excluded from `pnpm test`

## Linting

- ESLint 9 flat config. Unused vars starting with `_` are allowed.
- `@typescript-eslint/no-explicit-any`: warn (not error).
- Pre-commit hook (Husky + lint-staged): runs `eslint --fix` then `pnpm typecheck` on staged `.ts` files.

## Conventions

- Commit style: conventional commits (`feat(scope):`, `fix(scope):`, `docs:`, `test(scope):`)
- Runtime data: `~/.isotopes/` (overridable via `ISOTOPES_HOME`)
- Config: `~/.isotopes/isotopes.yaml`
- Environment variables load from `.env.local` (gitignored)
- Logging: `createLogger("tag")` — format `[ISO] [LEVEL] [tag] message`, controlled by `LOG_LEVEL` or `DEBUG=isotopes`
