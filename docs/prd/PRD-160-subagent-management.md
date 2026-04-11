# PRD-160: Subagent Management Tools

**Issue:** #160  
**Status:** Draft  
**Date:** 2025-04-12  
**Author:** Fairy  
**Depends on:** None (builds on existing infrastructure)

---

## Problem Statement

Agents can spawn subagents via `spawn_subagent` tool, but have no visibility or control over running subagents. They cannot:
- List what subagents are currently running
- Check status of a specific subagent task
- Cancel a runaway or stuck subagent
- Get results from a completed subagent task

This limits the orchestrator pattern — an agent spawning multiple subagents cannot manage them effectively.

---

## Current State

### Existing Infrastructure

**`src/tools/subagent.ts`:**
- `spawnSubagent()` — spawn a subagent, returns `SpawnSubagentResult`
- `cancelSubagent(pattern?)` — cancel by pattern
- `hasRunningSubagents()` — boolean check
- `getActiveSubagentCount()` — count of active subagents

**`src/subagent/task-registry.ts`:**
- `TaskRegistry` class tracks running tasks
- `register(taskId, sessionId, channelId)` — add task
- `unregister(taskId)` — remove task
- `get(taskId)` — get single task info
- `getBySession(sessionId)` — get tasks for session
- `list()` — list all tasks

**`TaskInfo` interface:**
```typescript
interface TaskInfo {
  taskId: string;
  sessionId: string;
  channelId: string;
  startedAt: Date;
}
```

### Gap Analysis

The infrastructure exists but is not exposed as agent tools:
1. `taskRegistry.list()` exists → need `subagents_list` tool
2. `taskRegistry.get()` exists → need `subagents_status` tool  
3. `cancelSubagent()` exists → need `subagents_cancel` tool
4. No result persistence → completed tasks vanish immediately

---

## Proposed Solution

### New Tools (3)

#### 1. `subagents_list`

List all running subagent tasks, optionally filtered.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `session_id` | string | No | Filter by session ID |
| `channel_id` | string | No | Filter by channel ID |

**Returns:**
```json
{
  "tasks": [
    {
      "task_id": "subagent-1-1712937600000",
      "session_id": "session-abc",
      "channel_id": "channel-123",
      "started_at": "2025-04-12T10:00:00Z",
      "running_seconds": 45
    }
  ],
  "count": 1
}
```

**Implementation:**
```typescript
function subagentsList(params: { session_id?: string; channel_id?: string }) {
  let tasks = taskRegistry.list();
  
  if (params.session_id) {
    tasks = tasks.filter(t => t.sessionId === params.session_id);
  }
  if (params.channel_id) {
    tasks = tasks.filter(t => t.channelId === params.channel_id);
  }
  
  return {
    tasks: tasks.map(t => ({
      task_id: t.taskId,
      session_id: t.sessionId,
      channel_id: t.channelId,
      started_at: t.startedAt.toISOString(),
      running_seconds: Math.floor((Date.now() - t.startedAt.getTime()) / 1000),
    })),
    count: tasks.length,
  };
}
```

#### 2. `subagents_status`

Get detailed status of a specific subagent task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to query |

**Returns:**
```json
{
  "found": true,
  "task_id": "subagent-1-1712937600000",
  "status": "running",
  "session_id": "session-abc",
  "channel_id": "channel-123",
  "started_at": "2025-04-12T10:00:00Z",
  "running_seconds": 45
}
```

Or if not found:
```json
{
  "found": false,
  "task_id": "subagent-1-1712937600000",
  "status": "unknown"
}
```

**Note:** Current TaskRegistry only tracks running tasks. Completed tasks are unregistered immediately. For MVP, `found: false` means either completed or never existed.

**Future enhancement:** Keep completed task results in a separate cache (with TTL) so agents can query results after completion.

#### 3. `subagents_cancel`

Cancel a running subagent task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to cancel |

**Returns:**
```json
{
  "cancelled": true,
  "task_id": "subagent-1-1712937600000"
}
```

Or if not found/already completed:
```json
{
  "cancelled": false,
  "task_id": "subagent-1-1712937600000",
  "reason": "task not found"
}
```

**Implementation:**
```typescript
function subagentsCancel(params: { task_id: string }) {
  const task = taskRegistry.get(params.task_id);
  if (!task) {
    return { cancelled: false, task_id: params.task_id, reason: "task not found" };
  }
  
  const success = cancelSubagent(params.task_id);
  return { cancelled: success, task_id: params.task_id };
}
```

---

## Implementation Plan

### Phase 1: MVP (This PR)

**New file: `src/tools/subagent-management.ts`**
- `subagentsList()`
- `subagentsStatus()`
- `subagentsCancel()`

**Update: `src/tools/registry.ts`**
- Register three new tools with proper schemas

**Tests: `src/tools/subagent-management.test.ts`**
- Unit tests for each tool
- Edge cases: empty list, not found, already cancelled

### Phase 2: Future Enhancements

1. **Result caching** — Keep completed task results for N minutes
2. **Progress tracking** — Stream progress events to TaskInfo
3. **Bulk cancel** — Cancel all tasks for a session/channel
4. **Task naming** — Allow agents to name tasks for easier management

---

## Access Control

These tools operate on the calling agent's subagents only:
- `subagents_list` — Returns all tasks (no cross-agent isolation in MVP since taskRegistry is global)
- `subagents_cancel` — Can cancel any task (MVP; future: restrict to own tasks)

**Future:** Add `agentId` to TaskInfo and filter by calling agent's ID.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No running tasks | Return empty list, `count: 0` |
| Task not found | Return `found: false` or `cancelled: false` with reason |
| Cancel fails | Return `cancelled: false` with reason |

No exceptions thrown — tools always return structured responses.

---

## Testing Strategy

1. **Unit tests:**
   - List with no tasks
   - List with multiple tasks, verify filtering
   - Status of running task
   - Status of non-existent task
   - Cancel running task
   - Cancel non-existent task

2. **Integration tests:**
   - Spawn subagent → list → verify appears
   - Spawn subagent → cancel → verify stops
   - Spawn subagent → complete → verify disappears from list

---

## Open Questions

1. **Cross-agent visibility** — Should agents see other agents' subagents? MVP: yes (global registry). Future: isolate by agentId.

2. **Result persistence** — How long to keep completed task results? Defer to Phase 2.

3. **Bulk operations** — `subagents_cancel_all` for a session? Defer to Phase 2.

---

## Summary

| Tool | Purpose | Wraps |
|------|---------|-------|
| `subagents_list` | List running tasks | `taskRegistry.list()` |
| `subagents_status` | Get task details | `taskRegistry.get()` |
| `subagents_cancel` | Stop a task | `cancelSubagent()` |

Straightforward exposure of existing infrastructure as agent tools.
