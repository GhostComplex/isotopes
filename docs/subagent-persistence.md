# Subagent run persistence

This doc captures how subagent runs are recorded so future backends (e.g. the
in-process / built-in backend tracked in #399) can plug in without redoing the
plumbing. Read this before adding a new subagent backend or changing the event
schema.

## Goals

- Reuse the existing `SessionStore` rather than introducing a parallel store.
- One transcript shape across main agents and subagents — downstream consumers
  (UIs, exports, future analytics) read both the same way.
- Backend-agnostic: a backend just emits `SubagentEvent`s; persistence is
  attached by the spawn layer, not the backend.
- Fail-safe: persistence errors must never break a running subagent.

## Virtual agentId scheme

Each subagent run is its own session, keyed by a virtual agentId derived from
the parent agent and the run's task ID:

```
subagent:<parentAgentId>:<taskId>
```

`subagentAgentId(parent, task)` in `src/subagent/persistence.ts` is the single
source of truth for this format. Don't reconstruct it inline.

The session is created at run start via `store.create(virtualAgentId, metadata)`
and gets a fresh JSONL transcript file like any other session.

## Session metadata

`SessionMetadata.transport` includes a `"subagent"` discriminator. The
subagent-specific payload lives under `metadata.subagent`:

```ts
interface SubagentSessionMetadata {
  parentAgentId: string;
  parentSessionId?: string;  // the session that spawned this run, if any
  taskId: string;
  backend: string;           // e.g. "claude-cli", later "builtin"
  cwd?: string;
  prompt?: string;
  exitCode?: number;         // populated on done
  costUsd?: number;          // populated on done
  durationMs?: number;       // computed at terminal event
  error?: string;            // populated on error
}
```

Lifecycle metadata (`exitCode`, `costUsd`, `durationMs`, `error`) is patched in
via `SessionStore.setMetadata` from the recorder when terminal events arrive.
Use `setMetadata` rather than re-creating the session — it preserves the
key index and merges shallowly.

## Event → Message mapping

`eventToMessage(event)` in `src/subagent/persistence.ts` is the adapter. Adding
a new event type? Extend that function in one place.

| `SubagentEvent.type` | Persisted? | Shape |
|---|---|---|
| `start`              | no         | drives session creation only |
| `message`            | yes        | `assistant` text block |
| `tool_use`           | yes        | `assistant` text `🔧 Name(input)` (truncated to 4 KB) — structured `tool_use` blocks deferred, see "Future work" |
| `tool_result`        | yes        | `tool_result` block, output truncated to 4 KB |
| `error`              | yes        | `assistant` text `❌ <message>` + metadata patch |
| `done`               | no         | drives metadata patch only |

`message.metadata.subagentEvent` is set on tool/error rows so consumers can
distinguish them from main-agent content if needed.

## Wiring (where things live)

```
spawnSubagent (src/tools/subagent.ts)
  └── createSubagentRecorder({ store, parentAgentId, taskId, ... })
        ├── store.create(virtualAgentId, metadata)   ← at run start
        ├── recorder.record(event)                   ← on every SubagentEvent
        └── recorder.patchMetadata(patch)            ← on done / error
```

The store is injected at app startup:

- `cli.ts` builds a dedicated `DefaultSessionStore` rooted at
  `getSubagentSessionsDir()` (`~/.isotopes/subagent-sessions`) when
  `config.subagent.enabled` is true.
- It calls `setSubagentSessionStore(store)` from `src/tools/subagent.ts`.
- `parentAgentId` is threaded from `createWorkspaceToolsWithGuards` →
  `createSubagentTool` → `runSubagent*` → `spawnSubagent`.

If no store is configured, `createSubagentRecorder` returns a no-op recorder so
the spawn loop has no conditional persistence branches.

## Adding a new backend

A backend (issue #399 will add a built-in one) only needs to:

1. Implement an async iterable that yields `SubagentEvent`s.
2. Plug into `SubagentBackend` so `backend.spawn(taskId, opts)` returns that
   iterable.

Persistence is automatic — `spawnSubagent` will record events and patch
metadata regardless of backend. Set `metadata.subagent.backend` to the new
backend name (e.g. `"builtin"`) when constructing the recorder so transcripts
are filterable.

## Fail-safe behaviour

- Store creation failure → log warn, return `NOOP_RECORDER`. The run still
  proceeds; it just isn't persisted.
- `addMessage` / `setMetadata` failures inside the recorder → log warn,
  swallow. Persistence is a best-effort sidecar, never on the critical path.

## Future work (out of scope for #400)

- Structured `tool_use` content blocks (would require extending
  `MessageContentBlock` and updating every consumer that pattern-matches on
  block kinds).
- TTL / GC tuning for the subagent store — currently shares the parent store's
  defaults via `SessionConfig`.
- Linking the subagent session back into the parent transcript as a
  `tool_result` block (today the link is one-way: parent → subagent via
  `parentSessionId`).
