# PRD-125: Usage Tracking

## Problem
No visibility into token consumption or cost per session/agent. Operators can't monitor usage or set budgets.

## Data Source
The `@mariozechner/pi-ai` SDK provides `Usage` on every `AssistantMessage`:

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

The `@mariozechner/pi-agent-core` emits `turn_end` events with:
```typescript
{ type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[]; }
```
When `message` is an `AssistantMessage`, it has `usage`.

## Current State
`pi-mono.ts` maps `turn_end` to `{ type: "turn_end" }` — discards the `message`.

## Design

### 1. Extend `AgentEvent` type (types.ts)

```typescript
// Add to AgentEvent union
| { type: "turn_end"; usage?: Usage }

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### 2. Extract usage in mapEvent (pi-mono.ts)

```typescript
case "turn_end": {
  const msg = e.message;
  // AssistantMessage has role="assistant" and usage field
  if (msg && "role" in msg && msg.role === "assistant" && "usage" in msg) {
    return { type: "turn_end", usage: msg.usage };
  }
  return { type: "turn_end" };
}
```

### 3. Aggregate usage in agent-runner.ts

Add per-session usage accumulation:

```typescript
interface SessionUsage {
  totalTokens: number;
  totalCost: number;
  turns: number;
}

// In AgentRunner, accumulate on turn_end events
if (event.type === "turn_end" && event.usage) {
  sessionUsage.totalTokens += event.usage.totalTokens;
  sessionUsage.totalCost += event.usage.cost.total;
  sessionUsage.turns++;
}
```

### 4. Expose via API

Add endpoint: `GET /api/sessions/:id/usage`

Response:
```json
{
  "sessionId": "abc123",
  "usage": {
    "totalTokens": 12500,
    "totalCost": 0.0125,
    "turns": 5,
    "breakdown": {
      "input": 10000,
      "output": 2500,
      "cacheRead": 5000,
      "cacheWrite": 1000
    }
  }
}
```

### 5. Dashboard display (optional M2)

Show usage stats in session detail panel. Not in scope for this PR.

## Files to Change

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `Usage` type, extend `turn_end` event |
| `src/core/pi-mono.ts` | Extract usage in `mapEvent` |
| `src/core/agent-runner.ts` | Accumulate usage per session |
| `src/api/routes.ts` | Add `/api/sessions/:id/usage` endpoint |
| `src/session/types.ts` | Add `usage` to session metadata (optional) |

## Test Plan

1. Unit test: `mapEvent` extracts usage from turn_end
2. Integration test: Full prompt returns accumulated usage
3. API test: `/api/sessions/:id/usage` returns correct totals

## Out of Scope

- Usage persistence across restarts (session store enhancement)
- Budget limits / alerts
- Dashboard UI
- Per-agent aggregation
