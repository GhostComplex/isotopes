# PRD-142: WebChat History Not Loading

## Problem

WebChat shows blank conversation on page revisit. Users lose all chat history.

## Root Cause Analysis

### Primary Cause: Two Store Instances Share One Directory

**In `cli.ts`:**
- Line 393-394: Discord transport creates `DefaultSessionStore({ dataDir: workspacePath/sessions })`
- Line 469-472: WebChat creates **another** `DefaultSessionStore({ dataDir: workspacePath/sessions })`

Both instances:
1. Maintain separate in-memory `Map<id, Session>`
2. Each calls `persistIndex()` independently
3. **Each overwrites the same `sessions.json`**

When Discord store persists, it only knows about Discord sessions → WebChat sessions get wiped from index.

### Secondary Issue: No Orphan Recovery

Even if index corruption happens for other reasons, there's no recovery path. `loadAllSessions()` only reads `sessions.json`, never scans for orphan `.jsonl` files.

**Evidence**:
- 12 `.jsonl` files exist in `workspace/sessions/`
- Only 7 sessions in `sessions.json`
- 5 orphaned sessions (3 WebChat, 2 Discord) have transcripts but no index entry

## Fix

### Fix 1: Separate WebChat Sessions Directory (Required)

Change WebChat to use its own directory:

```typescript
// cli.ts line 469
const chatSessionsDir = chatWorkspacePath
  ? path.join(chatWorkspacePath, "chat-sessions")  // NOT "sessions"
  : path.join(getSessionsDir(defaultChatAgentId), "..", "chat-sessions");
```

This completely isolates WebChat sessions from Discord sessions. No more cross-contamination.

**Alternative**: Reuse the same store instance for both transports. But this requires refactoring how `sessionStores` Map is structured — more invasive.

### Fix 2: Orphan Recovery in `init()` (Defense in Depth)

Even with Fix 1, add recovery logic to handle any future corruption:

1. After loading `sessions.json`, scan for `*.jsonl` files
2. For each orphan (jsonl exists, not in index):
   - Extract session ID from filename
   - Read last message timestamp for `lastActiveAt`
   - Use first configured agent as default `agentId`
   - Add to index, persist

This makes sessions self-healing.

## Implementation Plan

### Phase 1: Directory Separation

1. Change `chatSessionsDir` to use `"chat-sessions"` subdirectory
2. No migration needed — old orphaned sessions in `sessions/` can stay (they're already orphaned)
3. New WebChat sessions go to new directory

### Phase 2: Orphan Recovery

1. Add `scanOrphanTranscripts()` method to `DefaultSessionStore`
2. Call at end of `init()` after `loadAllSessions()`
3. For orphan files: extract session ID from filename, read last message for `lastActiveAt`, use configured agentId
4. Log warning for recovered sessions

## Files to Modify

- `src/cli.ts` — change `chatSessionsDir` path (Fix 1)
- `src/core/session-store.ts` — add `scanOrphanTranscripts()` (Fix 2)

## Test Plan

1. **Directory separation**: Create WebChat session, verify it appears in `chat-sessions/` not `sessions/`
2. **No cross-contamination**: Create Discord session, create WebChat session, restart, verify both persist
3. **Orphan recovery**: Manually remove session from `sessions.json`, restart, verify recovered

## Out of Scope

- Migrating existing orphaned sessions (they're already lost, users have moved on)
- Session header format for richer recovery metadata
