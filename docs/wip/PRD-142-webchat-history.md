# PRD-142: WebChat History Not Loading

## Problem

WebChat shows blank conversation on page revisit. Users lose all chat history.

## Root Cause Analysis

**Finding**: `sessions.json` index is the single source of truth for `loadAllSessions()`. If a session is missing from the index, it's orphaned — even if its `{sessionId}.jsonl` transcript exists.

**Evidence**:
- 12 `.jsonl` files exist in `workspace/sessions/`
- Only 7 sessions in `sessions.json`
- 5 orphaned sessions (3 WebChat, 2 Discord) have transcripts but no index entry

**How orphaning happens**:
1. `create()` calls `await persistIndex()` — session is written to index ✅
2. `addMessage()` calls `debouncedPersistIndex()` with 1s delay
3. If process crashes before debounce fires, `lastActiveAt` isn't updated (minor)
4. **But**: If `sessions.json` gets corrupted/truncated, or a race condition causes overwrite, sessions are lost permanently

**Missing recovery path**: `loadAllSessions()` only reads `sessions.json`. No scan of orphan `.jsonl` files.

## Fix

### 1. Add orphan recovery in `init()`

After loading `sessions.json`, scan for `*.jsonl` files not present in the index. For each orphan:

1. Read first message from jsonl to get `agentId` (from session context) — **Problem**: jsonl doesn't store agentId directly
2. Use default agentId or mark as "unknown"
3. Read last message timestamp for `lastActiveAt`
4. Create session entry in memory + persist to index

### 2. Better approach: Store session metadata in jsonl header

Add a `{"type": "session", ...}` record as the first line of each jsonl file containing:
- `sessionId`
- `agentId`  
- `metadata` (transport, key, etc.)
- `createdAt`

This makes each jsonl file self-describing. Recovery becomes trivial: parse the header line.

**Migration**: On load, if first line is `type: "message"`, this is legacy format. For recovery, default to first agent.

## Implementation Plan

### Phase 1: Orphan recovery (immediate fix)

1. Add `scanOrphanTranscripts()` method to `DefaultSessionStore`
2. Call it at end of `init()` after `loadAllSessions()`
3. For orphan files: extract session ID from filename, read last message for `lastActiveAt`, use first configured agent as default
4. Log warning for recovered sessions

### Phase 2: Self-describing transcripts (optional, future)

1. Add session header record type
2. Write header on `create()`
3. Use header for recovery instead of guessing agentId

## Files to Modify

- `src/core/session-store.ts` — add `scanOrphanTranscripts()`, call in `init()`

## Test Plan

1. Create session, add messages, verify in index
2. Manually remove session from `sessions.json` (simulate corruption)
3. Call `init()` again
4. Verify session is recovered with correct messages

## Out of Scope

- Session header format (Phase 2)
- TTL cleanup of orphans (use same TTL as normal sessions)
