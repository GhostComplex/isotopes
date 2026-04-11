# PRD-159: sessions_yield Tool

## Problem

Agents need the ability to terminate or pause their own sessions, or request termination of sessions they're participating in. Currently, session termination is only available programmatically via `AcpSessionManager.terminateSession()` — agents have no way to gracefully end a session from within a tool call.

## Current State

### Existing Infrastructure

**AcpSessionManager (`src/acp/session-manager.ts`):**
- `terminateSession(sessionId)` — sets status to "terminated", notifies listeners ✅
- `updateSession(sessionId, { status })` — can set status to "paused" ✅
- `AcpSessionStatus` = "active" | "paused" | "terminated" ✅

**Session Lifecycle:**
- Sessions are in-memory only
- `purgeTerminated()` removes terminated sessions from memory
- No automatic cleanup — terminated sessions persist until purged

## Proposed Solution

### Tool: `sessions_yield`

Gracefully terminate or pause the current session or a specified session.

**Parameters:**
```typescript
{
  session_id?: string;    // Target session. Defaults to current session.
  action: "terminate" | "pause" | "resume";
  reason?: string;        // Optional reason for audit logging
}
```

**Returns:**
```typescript
{
  success: boolean;
  session_id: string;
  previous_status: AcpSessionStatus;
  new_status: AcpSessionStatus;
  message?: string;       // Error message if success=false
}
```

**Behavior by action:**

| Action | Effect | Use Case |
|--------|--------|----------|
| `terminate` | Sets status to "terminated" | Agent finished task, conversation over |
| `pause` | Sets status to "paused" | Waiting for human input, rate limited |
| `resume` | Sets status to "active" | Resuming after pause |

### Implementation

**File:** `src/tools/sessions.ts` (extend from #156/#157)

```typescript
export function createSessionsYieldTool(context: SessionsToolContext): Tool {
  return {
    name: "sessions_yield",
    description: "Terminate, pause, or resume a session",
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Target session ID. Defaults to current session."
        },
        action: {
          type: "string",
          enum: ["terminate", "pause", "resume"],
          description: "Action to perform"
        },
        reason: {
          type: "string",
          description: "Optional reason for the action"
        }
      },
      required: ["action"]
    },
    execute: async (params) => {
      const { session_id, action, reason } = params;
      const targetId = session_id ?? context.currentSessionId;
      
      if (!targetId) {
        return { success: false, message: "No session_id provided and no current session" };
      }
      
      const session = context.sessionManager.getSession(targetId);
      if (!session) {
        return { success: false, message: `Session ${targetId} not found` };
      }
      
      // Access control: can only yield own sessions or sessions with permitted agents
      if (!canAccessSession(session, context)) {
        return { success: false, message: "Access denied" };
      }
      
      const previousStatus = session.status;
      
      // State machine validation
      if (action === "resume" && previousStatus !== "paused") {
        return { 
          success: false, 
          message: `Cannot resume session in status "${previousStatus}"` 
        };
      }
      
      if (action === "terminate" && previousStatus === "terminated") {
        return { 
          success: false, 
          message: "Session already terminated" 
        };
      }
      
      // Execute action
      const newStatus = action === "terminate" ? "terminated" 
                      : action === "pause" ? "paused" 
                      : "active";
      
      const updated = context.sessionManager.updateSession(targetId, { status: newStatus });
      
      // Log reason if provided
      if (reason && updated) {
        context.logger?.debug(`sessions_yield: ${action} session ${targetId}: ${reason}`);
      }
      
      return {
        success: !!updated,
        session_id: targetId,
        previous_status: previousStatus,
        new_status: newStatus
      };
    }
  };
}
```

### Access Control

**Who can yield a session:**
1. The agent that owns the session (`session.agentId === currentAgentId`)
2. Any agent when the session's agent is in `allowedAgents`

**Edge cases:**
- Terminating current session: allowed, but agent should know subsequent tool calls in this turn may fail
- Terminating another agent's session: only if that agent is in allowedAgents
- Self-terminate while `expect_reply` pending elsewhere: the waiting session gets timeout error

### State Transitions

```
         ┌─────────┐
    ┌────│ active  │────┐
    │    └─────────┘    │
    │         │         │
    │      pause      terminate
    │         │         │
    │         v         │
    │    ┌─────────┐    │
    └────│ paused  │    │
   resume└─────────┘    │
              │         │
           terminate    │
              │         │
              v         v
         ┌─────────────────┐
         │   terminated    │
         └─────────────────┘
```

**Invalid transitions:**
- `terminate` → anything (terminal state)
- `active` → `resume` (no-op or error?)
- `paused` → `pause` (no-op)

**Decision:** Invalid transitions return `success: false` with descriptive message. No-ops (pause already paused) return `success: true` with same status.

## Config Gate

Same as #156/#157:
- Tool only registered when `acp.enabled: true`
- `allowedAgents` controls cross-agent session access

## Testing

```typescript
describe("sessions_yield", () => {
  it("terminates own session", async () => {
    const session = manager.createSession("fairy");
    const result = await tool.execute({ action: "terminate" });
    expect(result.success).toBe(true);
    expect(result.new_status).toBe("terminated");
  });
  
  it("pauses and resumes session", async () => {
    const session = manager.createSession("fairy");
    await tool.execute({ action: "pause" });
    expect(manager.getSession(session.id)?.status).toBe("paused");
    
    await tool.execute({ action: "resume" });
    expect(manager.getSession(session.id)?.status).toBe("active");
  });
  
  it("rejects resume on active session", async () => {
    const session = manager.createSession("fairy");
    const result = await tool.execute({ action: "resume" });
    expect(result.success).toBe(false);
  });
  
  it("rejects terminating other agent's session without permission", async () => {
    // ...
  });
  
  it("allows terminating permitted agent's session", async () => {
    // ...
  });
});
```

## Dependencies

- **#156** — `SessionsToolContext` pattern and `sessions.ts` file structure
- **AcpSessionManager** — `updateSession()` already supports status changes ✅

## Open Questions (Deferred)

1. **Purge policy:** When should terminated sessions be purged from memory? Timer-based? Count-based?
2. **Pause timeout:** Should paused sessions auto-terminate after X minutes?
3. **Graceful shutdown:** Should `sessions_yield terminate` send a final message to the other party?
4. **Current session tracking:** How does `context.currentSessionId` get populated? (May need middleware)

---

*Author: Fairy*
*Date: 2025-04-12*
*Status: Draft — pending review*
