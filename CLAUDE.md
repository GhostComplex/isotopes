# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Isotopes is a self-hostable AI agent framework for multi-agent collaboration across chat platforms (Discord today, Feishu future). Agents have self-evolving prompts (SOUL.md, MEMORY.md), per-account routing, cron automation, sandbox execution, and daemon mode.

## Commands

```bash
pnpm install           # Install dependencies (pnpm is canonical, not npm)
pnpm build             # Compile TypeScript (plain tsc -> dist/)
pnpm dev               # Run without building (tsx src/legacy/cli.ts)
pnpm lint              # ESLint
pnpm lint:fix          # ESLint with auto-fix
pnpm typecheck         # tsc --noEmit
pnpm test              # Vitest (unit tests only, excludes integration/)
pnpm test:watch        # Vitest in watch mode
pnpm ci                # lint + typecheck + test (full local validation)

# Single test file
npx vitest run src/agent/tools/index.test.ts

# Single test by name
npx vitest run -t "registers a tool"

# Integration tests (requires DISCORD_TOKEN + DISCORD_TEST_CHANNEL env vars)
pnpm test:integration
```

## Architecture

**Module resolution**: ESM-only (`"type": "module"`). All imports use `.js` extensions (NodeNext resolution). Target: ES2022. Node >= 20.

### Top-level src/ layout

- `agent/` — Agent runtime, runners, tools, workspace loading, and per-agent host/sandbox middleware (executor, fs bridge, docker container manager, sandbox config). The new home for everything that defines what an agent *is* and how it runs.
- `gateway/` — Typed Gateway abstraction: canonical entrypoint for all inbound messages. Owns dispatch (fire-and-forget), subscribe (session event fan-out), session CRUD, abort, and cwd resolution. Channel adapters, HTTP, cron, and heartbeat all go through Gateway.
- `channels/` — Channel adapters. Today: `channels/discord/` (full Discord adapter — inbound pipeline, outbound streaming, dedupe, channel history, image attachments, /stop interception, A2A sink for spawn_agent threads, react, allowlists).
- `http/` — REST API server built on Hono + `@hono/node-server`. Routes for sessions, dispatch, cron, status. `POST /dispatch` is fire-and-forget; `GET /stream` is the SSE event source. Depends only on `{ cronScheduler, gateway }`.
- `sessions/` — Session type definitions only; the in-memory + JSONL impl lives in `agent/pi/session-store.ts`.
- `automation/` — `CronScheduler` (cron-based task scheduling) and `HeartbeatManager` (periodic agent wake-ups). `types.ts` holds the config-shape `CronActionConfig`.
- `daemon/` — macOS-only LaunchAgent install/uninstall/restart/status (`launchd.ts`). Other platforms: run `isotopes` in the foreground or supervise it yourself.
- `init/` — `isotopes init` setup wizard built with Ink.
- `logging/` — `createLogger("tag")` factory.
- `extensions/` — Discovery for user-managed customization at `~/.isotopes/extensions/`. Three typed slots: `pi/loader.ts` (pi-coding-agent extensions from `~/.isotopes/extensions/pi/*.ts`), `ui/loader.ts` (static SPA dirs from `~/.isotopes/extensions/ui/<id>/`, mounted at `/ui/<id>`), and `channels/loader.ts` (loads built-in channel adapters from `channels/`).
- `legacy/` — Transitional area being decomposed PR-by-PR. New code should not land here.
- Standalone files: `app.ts` (daemon wiring), `config.ts` (YAML config + schema), `paths.ts` (`ISOTOPES_HOME` resolution), `test-helpers.ts` (shared test mocks).

### `src/agent/`

- `runtime.ts` — `AgentRuntime`: in-memory agent registry + per-run dispatcher. Validates `RunRequest`, resolves session ID, delegates to a runner.
- `types.ts` — `RegisteredAgent`, `RunRequest`, `RunInfo`, `AgentConfig`, `ProviderConfig`, `RunValidationError`.
- `pi/` — Pi backbone (default agent runtime, not a swappable adapter). Wraps `@mariozechner/pi-agent-core` + `@mariozechner/pi-coding-agent`: `runner.ts`, `session-factory.ts`, `session-store.ts`, `messages.ts`, `system-prompt-override.ts`, `tool-result-truncation.ts`. Other isotopes modules (transports, HTTP, gateway) are allowed to depend on these directly — pi is the host, not a guest.
- `adapters/claude/` — Third-party adapter for the Claude Agent SDK. Implements the same `Runner` interface but lives under `adapters/` to signal "alternative entry point, not the backbone".
- `tools/` — Built-in agent tools (`web` for `web_fetch`, `react` for channel reactions) and the registry (`index.ts`) that assembles per-agent tool sets.
- `workspace/` — Loads `SOUL.md` / `TOOLS.md` / `MEMORY.md` / `BOOTSTRAP.md` into system prompts; manages workspace state and template files.

### `src/legacy/` (transitional)

- `cli.ts` — CLI entry point. Parses args, dispatches subcommands, runs foreground. Includes `isotopes service install/uninstall/restart/status` for macOS LaunchAgent management. Dynamically imports `init/wizard.tsx` and `tui/index.tsx`.
- `tui/` — Terminal UI for interactive chat mode.
- `version.ts` — Build version constant.

### Key patterns

- **Pluggable runner**: `AgentRuntime` dispatches to a runner per agent (`pi` default, `claude` alternative). Swap runners without touching gateway, sandbox, or transport code.
- **Tool registry**: Tools are `(schema, handler)` pairs assembled per-agent in `agent/tools/index.ts`; tool guards (CLI, FS) are enforced at registration and injected into system prompts.
- **Extensions (pi-native)**: User-authored extensions in `~/.isotopes/extensions/pi/*.ts` are loaded via pi-coding-agent's `DefaultResourceLoader` and shared across all agents (loader is cached per-agentId in `session-factory.ts`). Per-agent capability scoping is via `tools.allow` / `tools.deny`, not separate extension sets.
- **Event streaming**: `AgentRuntime.run()` returns `AsyncIterable<AgentEvent>` — discriminated union of turn_start, text_delta, tool_call, tool_result, turn_end, agent_end, error. Gateway's `ingestRunnerEvents` translates these into `SessionEvent` for consumers.
- **Workspace context**: `SOUL.md` / `TOOLS.md` / `MEMORY.md` / `BOOTSTRAP.md` are merged into system prompts and hot-reloaded on change.

## Testing

- Framework: Vitest with `globals: true`
- Tests are co-located with source files (`.test.ts` suffix in same directory)
- Additional tests in `tests/` (top-level)
- Mock helpers in `src/test-helpers.ts`
- Integration tests in `tests/integration/` are excluded from `pnpm test`

## Linting

- ESLint 9 flat config. Unused function args starting with `_` are allowed (local vars are not exempted).
- `@typescript-eslint/no-explicit-any`: warn (not error).
- Pre-commit hook (Husky + lint-staged): runs `eslint --fix` then `pnpm typecheck` on staged `.ts` files.

## Conventions

- Commit style: conventional commits (`feat(scope):`, `fix(scope):`, `docs:`, `test(scope):`)
- Runtime data: `~/.isotopes/` (overridable via `ISOTOPES_HOME`)
- Config: `~/.isotopes/isotopes.yaml`
- Environment variables load from `.env.local` (gitignored)
- Logging: `createLogger("tag")` — format `[ISO] [LEVEL] [tag] message`, controlled by `LOG_LEVEL` or `DEBUG=isotopes`

## Project Management

GitHub Project [#11 isotopes](https://github.com/orgs/GhostComplex/projects/11) tracks all work. Status column rules:

| Column | Meaning | Agent action |
|---|---|---|
| **Backlog** | Idea captured, not yet vetted. Default column for newly created issues. | Read for context. **Do not pick up.** |
| **Ready** | Triaged and approved for work. | **Pick from here** when looking for work. |
| **In progress** | Actively being worked on. | Move here when you start; one issue per worktree. |
| **In review** | PR open, awaiting review/merge. | Move here as soon as you open the PR. |
| **Done** | Merged. | Auto on merge — don't touch. |
| **Archive** | Human-only historical record. | **Read-only.** Never change status, never reopen. |

Workflow:
- New issue → Backlog (human triages to Ready)
- Pick a Ready issue → move to In progress → open worktree
- Open PR → move to In review (link the issue with `Closes #N` in the PR body)
- Merge → Done (automatic)

**Never commit directly to `main`.** All changes go through a worktree + PR, even one-line doc fixes. `main` is updated only via merged PRs.
