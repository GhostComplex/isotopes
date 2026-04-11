# PRD-156: sessions_spawn + announce Tools

## Summary

Add two new agent tools:
1. `sessions_spawn` — Create a new session for inter-agent or cross-transport communication
2. `sessions_announce` — Broadcast a message to other agents/sessions

## Current State

```typescript
// AcpSessionManager exists (src/acp/session-manager.ts):
- createSession(agentId, threadId?) → AcpSession
- getSession(sessionId) → AcpSession | undefined
- terminate(sessionId)

// AgentMessageBus exists (src/acp/message-bus.ts):
- send(message) → MessageDelivery
- broadcast(fromAgentId, content) → MessageDelivery[]
- subscribe(agentId, handler)
```

**Gap:** These are internal APIs. Agents have no tools to invoke them directly.

## Target Tool Schemas

### `sessions_spawn`

```typescript
{
  name: "sessions_spawn",
  description: "Create a new session for async communication with another agent or transport",
  parameters: {
    target_agent_id: {
      type: "string",
      description: "Agent ID to create session for (must be in allowedAgents)",
    },
    thread_id: {
      type: "string",
      description: "Optional Discord thread ID to bind the session to",
      optional: true,
    },
    metadata: {
      type: "object",
      description: "Optional key-value metadata for the session",
      optional: true,
    },
  },
  returns: {
    session_id: "string — unique session ID",
    agent_id: "string — target agent",
    status: "string — 'active'",
  },
}
```

### `sessions_announce`

```typescript
{
  name: "sessions_announce",
  description: "Broadcast a message to all agents or a specific agent",
  parameters: {
    content: {
      type: "string",
      description: "Message content to broadcast",
    },
    to_agent_id: {
      type: "string",
      description: "Target agent ID (omit to broadcast to all)",
      optional: true,
    },
    to_session_id: {
      type: "string",
      description: "Target session ID (requires to_agent_id)",
      optional: true,
    },
    metadata: {
      type: "object",
      description: "Optional structured metadata",
      optional: true,
    },
  },
  returns: {
    message_id: "string — unique message ID",
    delivered: "boolean — true if at least one recipient received",
    recipients: "number — count of sessions that received",
  },
}
```

## Changes Required

### 1. New Tool File: `src/tools/sessions.ts`

```typescript
// Tool implementations for sessions_spawn and sessions_announce
// Wraps AcpSessionManager and AgentMessageBus

export interface SessionsToolContext {
  sessionManager: AcpSessionManager;
  messageBus: AgentMessageBus;
  currentAgentId: string;       // Calling agent's ID
  currentSessionId?: string;    // Calling session's ID (for fromSessionId)
}

export async function sessionsSpawn(
  ctx: SessionsToolContext,
  params: { target_agent_id: string; thread_id?: string; metadata?: Record<string, unknown> }
): Promise<{ session_id: string; agent_id: string; status: string }>

export async function sessionsAnnounce(
  ctx: SessionsToolContext,
  params: { content: string; to_agent_id?: string; to_session_id?: string; metadata?: Record<string, unknown> }
): Promise<{ message_id: string; delivered: boolean; recipients: number }>
```

### 2. Tool Registration (`src/tools/index.ts`)

Add `sessions_spawn` and `sessions_announce` to tool registry.

```typescript
// Tool definitions for schema exposure
export const sessionsSpawnTool: ToolDefinition = {
  name: "sessions_spawn",
  description: "Create a new session for async communication with another agent",
  inputSchema: { /* ... */ },
};

export const sessionsAnnounceTool: ToolDefinition = {
  name: "sessions_announce", 
  description: "Broadcast a message to other agents or a specific session",
  inputSchema: { /* ... */ },
};
```

### 3. Tool Handler Integration (`src/core/agent-runner.ts` or tool dispatch)

- Inject `SessionsToolContext` when handling these tool calls
- Context must include: sessionManager, messageBus, currentAgentId, currentSessionId

### 4. Config Gate

Tools should only be available if ACP is enabled:
- Check `config.acp.enabled` before registering tools
- Return error if tools called but ACP disabled

## Validation Rules

### sessions_spawn
- `target_agent_id` must be in `config.acp.allowedAgents` (if configured)
- Cannot spawn session for self (use existing session)
- Return existing session if one already exists for agent+thread combo?

### sessions_announce
- If `to_session_id` is set, `to_agent_id` must also be set
- Message content must be non-empty
- Metadata keys must be strings

## Test Cases

1. **Basic spawn**: spawn session for allowed agent → returns session_id
2. **Spawn denied**: spawn for agent not in allowedAgents → error
3. **Spawn with thread binding**: spawn with thread_id → session bound to thread
4. **Announce to all**: announce without target → broadcasts to all agents
5. **Announce to agent**: announce with to_agent_id → only that agent receives
6. **Announce to session**: announce with to_agent_id + to_session_id → only that session receives
7. **ACP disabled**: call tools when acp.enabled=false → clear error message

## Edge Cases

1. **Concurrent spawns**: Two agents spawn session for same target simultaneously
   - First wins, second gets existing session (idempotent by agent+thread)
   
2. **Announce to offline agent**: Target agent has no active handlers
   - Message queued in `pendingByAgent`, delivered when agent subscribes
   
3. **Session cleanup**: What happens to spawned sessions when parent terminates?
   - Option A: Orphan (sessions live independently)
   - Option B: Cascade terminate
   - **Recommendation**: Orphan by default, add optional `cascade: true` param later

## Dependencies

- AcpSessionManager must be initialized (via AcpConfig)
- AgentMessageBus must be available
- Tool context must carry current agent/session IDs

## Open Questions

1. Should `sessions_spawn` be idempotent (return existing session if already exists)?
   - **Leaning yes** — safer for retry scenarios
   
2. Should we add `sessions_terminate` in this PR or separate (#159)?
   - **Separate** — #159 is explicitly sessions_yield

3. Rate limiting on announce?
   - Defer to future — not blocking for MVP

## Files to Change

```
src/tools/sessions.ts          — NEW: tool implementations
src/tools/sessions.test.ts     — NEW: tests
src/tools/index.ts             — register new tools
src/core/tool-dispatch.ts      — handle sessions_* calls (if separate dispatcher exists)
```

## Backward Compatibility

- New tools, no breaking changes
- Tools only appear if ACP enabled
- Existing ACP internals unchanged
