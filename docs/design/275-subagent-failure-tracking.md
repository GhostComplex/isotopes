# Design: #275 Subagent Failure Tracking

## Issue
https://github.com/GhostComplex/isotopes/issues/275

## Problem
Agent repeatedly spawns failing subagents for the same task, ignoring:
1. Previous failures (exit code 3 = max turns)
2. Explicit `/stop` commands from user

## Solution

### 1. FailureTracker — per-session task failure memory

Track task failures by hashing the task description. After N failures, refuse to spawn.

```typescript
// src/subagent/failure-tracker.ts

interface FailureRecord {
  count: number;
  lastError: string;
  cancelled: boolean; // True if /stop was used
}

class FailureTracker {
  // sessionId -> taskHash -> FailureRecord
  private failures = new Map<string, Map<string, FailureRecord>>();
  
  recordFailure(sessionId: string, task: string, error: string): void;
  recordCancel(sessionId: string, task: string): void;
  shouldBlock(sessionId: string, task: string, maxFailures: number): { blocked: boolean; reason?: string };
  clearSession(sessionId: string): void;
}
```

### 2. Task Hash Function

Simple hash based on task description (normalized):
- Lowercase
- Remove extra whitespace
- Hash first 200 chars (captures essence of task)

```typescript
function hashTask(task: string): string {
  const normalized = task.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 200);
  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
  }
  return hash.toString(36);
}
```

### 3. Integration Points

**A. spawn_subagent handler (src/core/tools.ts)**

```typescript
handler: async (args) => {
  const { task, agent, working_directory } = args;
  
  // Get sessionId from subagent context
  const ctx = getSubagentContext();
  const sessionId = ctx?.sessionId;
  
  if (sessionId) {
    const check = failureTracker.shouldBlock(sessionId, task, 2);
    if (check.blocked) {
      return `[blocked] ${check.reason}`;
    }
  }
  
  // ... existing spawn logic ...
  
  if (!result.success && sessionId) {
    failureTracker.recordFailure(sessionId, task, result.error || 'unknown');
  }
  
  return result;
}
```

**B. /stop command handler (src/transports/discord.ts)**

When `/stop` kills a subagent, also record cancellation:

```typescript
if (task) {
  const killed = await killTask(task.taskId);
  if (killed && ctx.sessionId) {
    // We don't have the original task description here...
    // Need to store it in TaskInfo
  }
}
```

**Problem:** TaskInfo doesn't store the original task description. Need to add it.

### 4. Update TaskInfo

```typescript
export interface TaskInfo {
  taskId: string;
  sessionId: string;
  channelId: string;
  threadId?: string;
  startedAt: Date;
  task: string;  // NEW: original task description
}
```

### 5. File Changes

| File | Change |
|------|--------|
| `src/subagent/failure-tracker.ts` | NEW: FailureTracker class |
| `src/subagent/failure-tracker.test.ts` | NEW: tests |
| `src/subagent/task-registry.ts` | Add `task` field to TaskInfo |
| `src/core/tools.ts` | Check failure tracker before spawn |
| `src/core/subagent-context.ts` | Add sessionId to context |
| `src/transports/discord.ts` | Record cancel when /stop used |

### 6. Config

Default `maxFailures = 2`. Can be made configurable later.

## Test Plan

1. `recordFailure()` increments count
2. `shouldBlock()` returns true after 2 failures
3. `recordCancel()` marks task as cancelled
4. Cancelled tasks are immediately blocked
5. `clearSession()` resets all failure state

## Acceptance Criteria

- [ ] After 2 consecutive failures, same task is blocked with clear message
- [ ] `/stop` blocks task from being re-attempted
- [ ] Agent receives clear feedback when blocked
- [ ] No false positives (different tasks don't affect each other)
