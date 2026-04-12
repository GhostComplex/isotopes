# PRD: #268 — ACPX SDK Refactor

## Overview

Refactor `acpx-backend.ts` to use `@agentclientprotocol/sdk` instead of manual JSON-RPC parsing.

## Current State

`acpx-backend.ts` currently:
1. Spawns `npx acpx` with `--format json`
2. Manually parses stdout JSON lines via `parseAcpxJsonLine()`
3. Detects errors by scanning stderr (unreliable — acpx logs warnings to stderr even on success)
4. Falls back to `claude -p` with `parseJsonLine()` if acpx unavailable

## Target State

Use SDK's typed streaming:
1. `ndJsonStream(input, output)` — creates bidirectional JSON-RPC stream
2. `ClientSideConnection` — handles protocol handshake + typed notifications
3. `sessionUpdate` handler — receives typed `SessionNotification` objects
4. Typed `PromptResponse` — includes `stopReason`, `usage`, etc.

## Implementation

### Dependencies

Add direct dependency (currently transitive via acpx):
```bash
pnpm add @agentclientprotocol/sdk
```

### Changes to `acpx-backend.ts`

**Delete:**
- `parseAcpxJsonLine()` — SDK handles JSON-RPC parsing
- Stderr error detection — SDK provides typed errors

**Keep:**
- `parseJsonLine()` + `mapRawEvent()` — still needed for legacy `claude -p` fallback
- `buildAcpxArgs()` — still constructs CLI args
- `validateCwd()` / `validateAgent()` — security validation unchanged
- `cancel()` / `isRunning()` — process management unchanged

**New:**
- Import `ClientSideConnection`, `ndJsonStream`, `PROTOCOL_VERSION` from SDK
- `sessionUpdate` handler that converts `SessionNotification` → `AcpxEvent`
- Use `client.prompt()` for execution instead of raw stdin/stdout

### Event Mapping

| SDK `sessionUpdate` type | → `AcpxEvent.type` |
|--------------------------|---------------------|
| `agent_message_chunk` (text) | `message` |
| `tool_call` (pending) | `tool_use` |
| `tool_call_update` (completed) | `tool_result` |

| SDK response | → `AcpxEvent.type` |
|--------------|---------------------|
| `PromptResponse.stopReason` | `done` |
| Protocol error | `error` |

### Permission Handling

For Isotopes subagents, use `--approve-all` (already configured). SDK's `requestPermission` handler is no-op:
```typescript
requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
```

## Testing

- Existing `acpx-backend.test.ts` should pass
- Add integration test with mock acpx process

## Rollout

Feature flag: None needed. SDK is drop-in replacement — same external behavior.

## Not In Scope

- Changing legacy `claude -p` fallback behavior
- Session management (resume, fork) — Isotopes spawns fresh sessions
- MCP server configuration — not used in subagent spawning
