# Design: #273 — Subagent Thread Steer/Stop

## Problem

When a subagent is running and streaming output to a Discord thread:
1. User messages in that thread are not visible to Isotopes
2. No way to stop/cancel a running subagent from the thread
3. No way to steer (redirect) the subagent with additional input

The thread is effectively write-only.

## Root Cause Analysis

1. **Thread messages reach `handleMessage()`** — Discord's API does send them
2. **But they get filtered out** — by `shouldRespond()` logic or `threads.respond` config
3. **Even if they passed**, there's no routing to associate thread messages with a running subagent
4. **TaskRegistry tracks tasks** but doesn't track the thread they're streaming to

## Solution: Thread-to-Task Routing

### 1. Extend TaskRegistry to track threadId

```typescript
// task-registry.ts
export interface TaskInfo {
  taskId: string;
  sessionId: string;
  channelId: string;
  threadId?: string;       // NEW: thread where subagent streams output
  startedAt: Date;
}
```

When `DiscordSink.start()` creates a thread, register the threadId with the task.

### 2. `/stop` slash command in subagent thread

Add handler in `slash-commands.ts`:

```typescript
// When /stop is invoked in a thread:
// 1. Look up task by threadId in TaskRegistry
// 2. Call backend.cancel(taskId)
// 3. Reply "Subagent cancelled"
```

### 3. Thread message detection in handleMessage()

In `discord.ts handleMessage()`, before filtering:

```typescript
// Check if this message is in a subagent thread
const taskForThread = taskRegistry.getByThreadId(msg.channelId);
if (taskForThread) {
  // This is a subagent thread — route to special handler
  return this.handleSubagentThreadMessage(msg, taskForThread);
}
```

### 4. handleSubagentThreadMessage() — minimal P0

For P0, just support `/stop`:
- If message starts with `/stop` or `/cancel`, cancel the task
- Otherwise, acknowledge but don't forward (steering is P1)

## File Changes

| File | Changes |
|------|---------|
| `src/subagent/task-registry.ts` | Add `threadId` field, `getByThreadId()` method |
| `src/subagent/discord-sink.ts` | Register threadId when created |
| `src/tools/subagent.ts` | Pass threadId to TaskRegistry |
| `src/transports/discord.ts` | Add `handleSubagentThreadMessage()`, check before filters |
| `src/commands/slash-commands.ts` | Add `/stop` handler (reuse `/cancel`) |
| Tests for all above |

## Sequence Diagram

```
User: /spawn claude "fix bug"
  │
  ├─> subagent.ts: spawnSubagent() → taskId = "subagent-1"
  │     └─> taskRegistry.register(taskId, sessionId, channelId)
  │
  ├─> discord-sink.ts: DiscordSink.start()
  │     └─> Creates thread "fix bug"
  │     └─> taskRegistry.setThreadId(taskId, thread.id)
  │
  └─> Subagent runs, streams to thread...

User (in thread): /stop
  │
  ├─> discord.ts: handleMessage()
  │     └─> taskRegistry.getByThreadId(thread.id) → TaskInfo
  │     └─> handleSubagentThreadMessage(msg, task)
  │
  └─> discord.ts: handleSubagentThreadMessage()
        └─> backend.cancel(task.taskId)
        └─> reply("Subagent cancelled")
```

## Testing

1. Unit tests for TaskRegistry.getByThreadId()
2. Unit tests for handleSubagentThreadMessage() with `/stop`
3. Integration: mock thread message → verify task cancellation

## Future (P1 — Steering)

Forward non-command messages to the running subagent's stdin:
```typescript
// In handleSubagentThreadMessage():
if (!isCommand) {
  // Forward message content to subagent (if acpx supports stdin after start)
  // Currently not possible — acpx stdin is closed after prompt
  // Would need acpx/claude to support interactive input
}
```

Note: acpx closes stdin after initial prompt, so true steering requires acpx changes. P0 is stop-only.
