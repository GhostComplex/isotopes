# PRD-158: sessions_list + sessions_history Tools

## Problem

Agents need to discover and query sessions to:
1. Find sessions involving specific agents
2. Check session status (active/paused/terminated)
3. Read historical messages from sessions for context

Currently `AcpSessionManager.listSessions()` exists but isn't exposed as an agent tool.

## Solution

Add two tools to `src/tools/sessions.ts`:

### 1. `sessions_list`

Query sessions with optional filtering.

```typescript
interface SessionsListParams {
  agent_id?: string;    // Filter by participant agent
  status?: 'active' | 'paused' | 'terminated';
  limit?: number;       // Default: 20, max: 100
}

interface SessionsListResult {
  sessions: Array<{
    session_id: string;
    participants: string[];  // agent IDs
    status: string;
    created_at: string;
    last_activity: string;
  }>;
  total: number;
}
```

### 2. `sessions_history`

Read message history from a specific session.

```typescript
interface SessionsHistoryParams {
  session_id: string;   // Required
  limit?: number;       // Default: 50, max: 200
  before?: string;      // Cursor for pagination (message timestamp)
}

interface SessionsHistoryResult {
  messages: Array<{
    id: string;
    from: string;       // agent ID
    content: string;
    timestamp: string;
  }>;
  has_more: boolean;
  next_cursor?: string;
}
```

## Implementation

### File: `src/tools/sessions.ts`

Extend the file created in #156 with two new tools:

```typescript
export const sessionsListTool: AgentTool<SessionsListParams, SessionsListResult> = {
  name: 'sessions_list',
  description: 'List ACP sessions, optionally filtered by agent or status',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Filter by participant agent ID' },
      status: { type: 'string', enum: ['active', 'paused', 'terminated'] },
      limit: { type: 'number', default: 20, maximum: 100 }
    }
  },
  execute: async (params, context: SessionsToolContext) => {
    const { sessionManager, allowedAgents, currentAgentId } = context;
    
    let sessions = sessionManager.listSessions();
    
    // Filter by agent_id if specified
    if (params.agent_id) {
      // Access control: can only query allowed agents
      if (!allowedAgents.includes(params.agent_id)) {
        throw new Error(`Cannot query sessions for agent: ${params.agent_id}`);
      }
      sessions = sessions.filter(s => s.participants.includes(params.agent_id));
    }
    
    // Filter by status if specified
    if (params.status) {
      sessions = sessions.filter(s => s.status === params.status);
    }
    
    // Apply limit
    const limit = Math.min(params.limit ?? 20, 100);
    const total = sessions.length;
    sessions = sessions.slice(0, limit);
    
    return {
      sessions: sessions.map(s => ({
        session_id: s.id,
        participants: s.participants,
        status: s.status,
        created_at: s.createdAt,
        last_activity: s.lastActivity
      })),
      total
    };
  }
};

export const sessionsHistoryTool: AgentTool<SessionsHistoryParams, SessionsHistoryResult> = {
  name: 'sessions_history',
  description: 'Read message history from a specific ACP session',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID to read history from' },
      limit: { type: 'number', default: 50, maximum: 200 },
      before: { type: 'string', description: 'Pagination cursor (message timestamp)' }
    },
    required: ['session_id']
  },
  execute: async (params, context: SessionsToolContext) => {
    const { sessionManager, allowedAgents, currentAgentId } = context;
    
    const session = sessionManager.getSession(params.session_id);
    if (!session) {
      throw new Error(`Session not found: ${params.session_id}`);
    }
    
    // Access control: current agent must be participant OR querying allowed agents
    const isParticipant = session.participants.includes(currentAgentId);
    const allParticipantsAllowed = session.participants.every(p => 
      p === currentAgentId || allowedAgents.includes(p)
    );
    
    if (!isParticipant && !allParticipantsAllowed) {
      throw new Error(`Access denied to session: ${params.session_id}`);
    }
    
    let messages = session.history;
    
    // Apply before cursor
    if (params.before) {
      const beforeTime = new Date(params.before).getTime();
      messages = messages.filter(m => new Date(m.timestamp).getTime() < beforeTime);
    }
    
    // Apply limit
    const limit = Math.min(params.limit ?? 50, 200);
    const hasMore = messages.length > limit;
    messages = messages.slice(-limit);  // Most recent first
    
    return {
      messages: messages.map(m => ({
        id: m.id,
        from: m.from,
        content: m.content,
        timestamp: m.timestamp
      })),
      has_more: hasMore,
      next_cursor: hasMore ? messages[0]?.timestamp : undefined
    };
  }
};
```

### Tool Registration

Add to `createSessionsTools()` function:

```typescript
export function createSessionsTools(context: SessionsToolContext): AgentTool[] {
  return [
    sessionsSpawnTool,      // #156
    sessionsAnnounceTool,   // #156
    sessionsSendTool,       // #157
    sessionsListTool,       // #158
    sessionsHistoryTool,    // #158
  ];
}
```

## Access Control

| Tool | Who can use |
|------|-------------|
| `sessions_list` | Any agent; can only filter by `allowedAgents` |
| `sessions_history` | Participant of session OR all participants in `allowedAgents` |

## Dependencies

- #156 merged (provides `SessionsToolContext` and `src/tools/sessions.ts`)
- #157 for full sessions toolkit

## Testing

1. List sessions with no filter
2. List sessions filtered by agent_id (allowed vs denied)
3. List sessions filtered by status
4. Read history from own session
5. Read history from session with allowed agents
6. Read history from session with non-allowed agent (should fail)
7. Pagination with `before` cursor
8. Limit enforcement (max 100 for list, max 200 for history)

## Open Questions

1. **Session expiration** — Should terminated sessions be auto-cleaned after N days?
2. **Message content filtering** — Should we allow filtering messages by content/sender?
3. **Real-time updates** — Should `sessions_history` support "tail -f" mode via streaming?

For MVP: No to all. Keep it simple.
