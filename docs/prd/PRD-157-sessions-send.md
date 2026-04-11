# PRD-157: sessions_send Tool

## Summary

Add `sessions_send` tool — allows an agent to send a message to another agent or a specific session.

**Relationship to other session tools:**
- #156 `sessions_spawn` — create sessions
- #157 `sessions_send` — send messages (this PRD)
- #158 `sessions_list` — list/query sessions
- #159 `sessions_yield` — terminate/pause sessions

## Current State

```typescript
// AgentMessageBus (src/acp/message-bus.ts):
send(partial: Omit<AgentMessage, "id" | "timestamp">): MessageDelivery
broadcast(fromAgentId, content, metadata?): MessageDelivery[]
```

**Gap:** No tool exposes `send()` to agents. #156's `sessions_announce` is broadcast-focused; `sessions_send` is point-to-point.

## Distinction: sessions_send vs sessions_announce

| Tool | Purpose | Routing |
|------|---------|---------|
| `sessions_announce` (#156) | Broadcast/notify | One-to-many, all agents or one agent |
| `sessions_send` (#157) | Direct message | One-to-one, specific session preferred |

`sessions_send` is for targeted, conversational exchanges. `sessions_announce` is for notifications.

## Target Tool Schema

### `sessions_send`

```typescript
{
  name: "sessions_send",
  description: "Send a message to a specific agent or session",
  parameters: {
    to_agent_id: {
      type: "string",
      description: "Target agent ID (required)",
    },
    to_session_id: {
      type: "string",
      description: "Target session ID (optional — if omitted, routes to agent's default handler)",
      optional: true,
    },
    content: {
      type: "string",
      description: "Message content",
    },
    metadata: {
      type: "object",
      description: "Optional structured metadata (e.g., reply_to, priority)",
      optional: true,
    },
    expect_reply: {
      type: "boolean",
      description: "If true, block until recipient replies (timeout 30s). Default: false",
      optional: true,
    },
  },
  returns: {
    message_id: "string — unique message ID",
    delivered: "boolean — true if message reached at least one handler",
    reply: "string | null — reply content if expect_reply=true and reply received",
    reply_metadata: "object | null — reply metadata if present",
  },
}
```

## Implementation

### 1. Add to `src/tools/sessions.ts`

```typescript
export interface SessionsSendParams {
  to_agent_id: string;
  to_session_id?: string;
  content: string;
  metadata?: Record<string, unknown>;
  expect_reply?: boolean;
}

export interface SessionsSendResult {
  message_id: string;
  delivered: boolean;
  reply?: string;
  reply_metadata?: Record<string, unknown>;
}

export async function sessionsSend(
  ctx: SessionsToolContext,
  params: SessionsSendParams
): Promise<SessionsSendResult> {
  // Validate to_agent_id is in allowedAgents
  const config = ctx.sessionManager.getConfig();
  if (
    config.allowedAgents?.length &&
    !config.allowedAgents.includes(params.to_agent_id)
  ) {
    throw new Error(`Agent "${params.to_agent_id}" not in allowedAgents`);
  }

  // Send via message bus
  const delivery = ctx.messageBus.send({
    fromAgentId: ctx.currentAgentId,
    fromSessionId: ctx.currentSessionId,
    toAgentId: params.to_agent_id,
    toSessionId: params.to_session_id,
    content: params.content,
    metadata: params.metadata,
  });

  // If expect_reply, wait for response
  if (params.expect_reply) {
    const reply = await waitForReply(ctx, delivery.messageId, 30_000);
    return {
      message_id: delivery.messageId,
      delivered: delivery.delivered,
      reply: reply?.content,
      reply_metadata: reply?.metadata,
    };
  }

  return {
    message_id: delivery.messageId,
    delivered: delivery.delivered,
  };
}
```

### 2. Reply Correlation

For `expect_reply=true`, we need to correlate replies. Two options:

**Option A: Convention-based metadata**
- Sender includes `metadata.correlation_id = message_id`
- Recipient's reply includes same `correlation_id`
- Sender subscribes temporarily, filters by correlation_id

**Option B: Built-in reply mechanism**
- Add `replyTo(messageId, content, metadata)` to AgentMessageBus
- Auto-routes to original sender's session

**Recommendation:** Option A for MVP (no changes to message-bus.ts). Option B for v2.

### 3. Tool Registration

In `src/tools/index.ts`:

```typescript
export const sessionsSendTool: ToolDefinition = {
  name: "sessions_send",
  description: "Send a message to a specific agent or session",
  inputSchema: {
    type: "object",
    properties: {
      to_agent_id: { type: "string", description: "Target agent ID" },
      to_session_id: { type: "string", description: "Target session ID (optional)" },
      content: { type: "string", description: "Message content" },
      metadata: { type: "object", description: "Optional metadata" },
      expect_reply: { type: "boolean", description: "Wait for reply (default: false)" },
    },
    required: ["to_agent_id", "content"],
  },
};
```

### 4. Config Gate

Same as #156 — only available when `config.acp.enabled = true`.

## Validation Rules

1. `to_agent_id` required, must be in `allowedAgents` (if configured)
2. `to_session_id` optional — if provided, must be valid session ID
3. `content` required, non-empty
4. `expect_reply` timeout is 30s, returns `reply: null` if timeout

## Test Cases

1. **Basic send**: send to agent → delivered=true, message_id returned
2. **Send to session**: send with to_session_id → routes to session handlers
3. **Send to offline agent**: no handlers → delivered=false, queued as pending
4. **allowedAgents check**: send to unlisted agent → error
5. **expect_reply success**: send with expect_reply=true, recipient replies → reply returned
6. **expect_reply timeout**: send with expect_reply=true, no reply → reply=null after 30s
7. **ACP disabled**: call when acp.enabled=false → clear error

## Edge Cases

1. **Self-send**: Agent sends to itself
   - Allow it — could be useful for async self-coordination
   - Should NOT block on expect_reply to self (deadlock)

2. **Session terminated mid-send**: Target session terminates after send but before reply
   - expect_reply returns reply=null (treat as timeout)

3. **High volume**: Many messages to same agent
   - AgentMessageBus already has MAX_PENDING_MESSAGES (100) cap
   - Oldest messages dropped — acceptable for MVP

## Dependencies

- #156 (sessions_spawn) should land first — provides SessionsToolContext pattern
- AgentMessageBus exists, no changes needed for basic send
- For expect_reply, add temporary subscription + timeout logic

## Files to Change

```
src/tools/sessions.ts       — add sessionsSend implementation
src/tools/sessions.test.ts  — add tests
src/tools/index.ts          — register sessionsSendTool
```

## Backward Compatibility

- New tool, no breaking changes
- Only available if ACP enabled

## Open Questions

1. **Reply correlation:** Convention-based (Option A) or built-in (Option B)?
   - **Recommendation:** Option A for MVP

2. **Timeout configurability:** Should expect_reply timeout be configurable?
   - **Recommendation:** Hardcode 30s for MVP, add param later if needed

3. **Delivery confirmation:** Should we add ack/nack mechanism?
   - **Recommendation:** Defer — `delivered` boolean is enough for MVP
