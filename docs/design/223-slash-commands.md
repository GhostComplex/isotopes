# Design: #223 Slash Commands — /new, /reset, /compact

## Issue
https://github.com/GhostComplex/isotopes/issues/223

## Goal
Add session management slash commands for user-facing session control.

## Scope

### This PR (P0)
1. `/new` — Create fresh session, clear current context
2. `/reset` — Alias for `/new`
3. `/compact` — Manual compaction trigger with before/after stats
4. `/compact <instructions>` — Compact with custom guidance (logged, not used yet)

### Future PR (P1)
- Daily reset (cron-based automatic session rotation)
- `/new <model>` — Model switch on reset

## Architecture Analysis

### Current Flow (discord.ts lines 326-337)
```typescript
if (this.commandHandler.isCommand(content)) {
  const agentId = this.resolveAgentId(msg);
  const result = await this.commandHandler.execute(content, {
    agentManager: this.config.agentManager,
    sessionStore: this.getSessionStore(agentId),
    agentId,
    userId: msg.author.id,
    username: msg.author.username,
  });
  await (msg.channel as SendableChannel).send(result.response);
  return;
}
```

**Problem:** Session is resolved AFTER slash command interception (line 362-363). For `/new` and `/compact`, we need the current session.

### Solution
Move session resolution BEFORE command dispatch for session-aware commands.

## Implementation

### 1. Extend CommandContext (slash-commands.ts)

```typescript
export interface CommandContext {
  agentManager: AgentManager;
  sessionStore: SessionStore;
  agentId: string;
  userId: string;
  username: string;
  // New fields for session-aware commands:
  sessionId?: string;         // Current session ID (may be undefined)
  sessionKey?: string;        // Session key for creating new session
  agentInstance?: AgentInstance;  // For forceCompact()
}
```

### 2. Add clearMessages to SessionStore

**types.ts:**
```typescript
export interface SessionStore {
  // ... existing methods
  /** Clear all messages from a session (keeps session, clears history) */
  clearMessages(sessionId: string): Promise<void>;
}
```

**session-store.ts:**
```typescript
async clearMessages(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  
  // Clear in-memory messages
  session.messages = [];
  session.messagesLoaded = true;
  session.lastActiveAt = new Date();
  
  // Truncate transcript file
  await fs.writeFile(this.transcriptFile(sessionId), "");
  await this.persistIndex();
}
```

### 3. Add Commands to SlashCommandHandler

```typescript
const KNOWN_COMMANDS = new Set([
  "status", "reload", "model",
  "new", "reset", "compact",  // NEW
]);
```

### 4. handleNew / handleReset

```typescript
private async handleNew(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.sessionId) {
    return { response: "ℹ️ No active session to reset." };
  }
  
  try {
    await ctx.sessionStore.clearMessages(ctx.sessionId);
    ctx.agentInstance?.clearMessages?.();
    
    log.info(`Session reset by ${ctx.username} (${ctx.userId})`);
    return { response: "✅ Session reset. Starting fresh." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Session reset failed: ${msg}`);
    return { response: `❌ Reset failed: ${msg}` };
  }
}
```

### 5. handleCompact

```typescript
private async handleCompact(ctx: CommandContext, instructions: string): Promise<CommandResult> {
  if (!ctx.sessionId) {
    return { response: "ℹ️ No active session to compact." };
  }
  
  if (!ctx.agentInstance?.forceCompact) {
    return { response: "❌ Compaction not supported for this agent." };
  }

  try {
    const messagesBefore = (await ctx.sessionStore.getMessages(ctx.sessionId)).length;
    const compacted = await ctx.agentInstance.forceCompact();
    
    if (!compacted) {
      return { response: "ℹ️ Nothing to compact (context too small)." };
    }
    
    const messagesAfter = (await ctx.sessionStore.getMessages(ctx.sessionId)).length;
    
    return {
      response: `✅ Compacted: ${messagesBefore} → ${messagesAfter} messages`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: `❌ Compaction failed: ${msg}` };
  }
}
```

### 6. Update Discord Transport (discord.ts)

```typescript
if (this.commandHandler.isCommand(content)) {
  const agentId = this.resolveAgentId(msg);
  const sessionStore = this.getSessionStore(agentId);
  const sessionKey = this.getSessionKey(msg, agentId);
  const session = await sessionStore.findByKey(sessionKey);
  const agent = this.config.agentManager.get(agentId);
  
  const result = await this.commandHandler.execute(content, {
    agentManager: this.config.agentManager,
    sessionStore,
    agentId,
    userId: msg.author.id,
    username: msg.author.username,
    sessionId: session?.id,
    sessionKey,
    agentInstance: agent,
  });
  await (msg.channel as SendableChannel).send(result.response);
  return;
}
```

## File Changes

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `clearMessages()` to SessionStore interface |
| `src/core/session-store.ts` | Implement `clearMessages()` |
| `src/core/session-store.test.ts` | Tests for `clearMessages()` |
| `src/commands/slash-commands.ts` | Add /new, /reset, /compact handlers |
| `src/commands/slash-commands.test.ts` | Tests for new commands |
| `src/transports/discord.ts` | Pass session context to CommandContext |

## Test Plan

### Unit Tests (slash-commands.test.ts)
- `/new` clears session messages, returns success
- `/reset` works as alias for `/new`
- `/new` with no active session returns info message
- `/compact` triggers compaction, returns stats
- `/compact` with no active session returns info message
- `/compact` with unsupported agent returns error

### Unit Tests (session-store.test.ts)
- `clearMessages()` clears in-memory messages
- `clearMessages()` truncates transcript file on disk
- `clearMessages()` on non-existent session throws
- `clearMessages()` updates lastActiveAt

## Out of Scope
- Daily reset (requires cron integration — separate PR)
- `/new <model>` model switch
- `/compact <instructions>` custom guidance (logged but not used)
- Token count display

## Acceptance Criteria
- [ ] `/new` clears current session messages
- [ ] `/reset` works as alias for `/new`
- [ ] `/compact` triggers manual compaction
- [ ] Admin permission enforced
- [ ] All unit tests pass
- [ ] Works in Discord transport
