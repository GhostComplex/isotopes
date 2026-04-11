# Backlog

Future work items not yet scheduled for a milestone.

---

## Subagent Abort Capability

**Priority:** Medium  
**Added:** 2026-04-09

**Problem:**  
Cannot interrupt a subagent running in a thread from the parent channel. If a subagent gets stuck or needs to be stopped, the only option is to restart Isotopes entirely.

**Solution Ideas:**
- `/abort <thread-id>` command from parent channel
- "stop" message trigger that propagates to subagent
- Timeout-based auto-abort

---

## Stale Thread Binding Cleanup on Restart

**Priority:** High  
**Added:** 2026-04-09

**Problem:**  
When Isotopes is force-restarted (killed), subagent thread bindings persist in memory/state. After restart, messages intended for the parent channel get routed to dead threads, causing the agent to appear unresponsive or "stuck" in a thread.

**Root Cause:**
1. Isotopes spawns Claude Code subagent → creates thread → binds thread to subagent
2. Force restart kills subagent mid-execution
3. Thread binding state not cleaned up
4. On restart, binding still active → messages route to wrong thread

**Solution Ideas:**
- On startup, scan for stale thread bindings (threads with no active subagent)
- Add TTL to thread bindings — auto-expire after N minutes of inactivity
- Store binding state in persistent storage, mark as "pending cleanup" on unclean shutdown
- Add `isotopes unbind --all` CLI command for manual cleanup

---

## Diff Preview Tool

**Priority:** Low  
**Added:** 2026-04-09

**Problem:**  
When using `iterate_self` tool to modify workspace files, there's no way to preview changes before applying.

**Solution Ideas:**
- `preview_diff` tool that shows proposed changes without applying
- Confirmation step in `iterate_self` workflow
- Undo/rollback mechanism using backup files
