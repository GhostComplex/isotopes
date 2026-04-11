# RCA: SDK `transformMessages` Orphans `toolResult` After Skipping Errored Assistant

**Date:** 2026-04-11
**Severity:** P0 (blocks agent recovery from any error during tool execution)
**Affected component:** `@mariozechner/pi-ai` → `providers/transform-messages.js`
**Symptom:** Recurring `400 Bad Request` from Anthropic API:
```
messages.0.content.0: unexpected `tool_use_id` found in `tool_result` blocks:
toolu_vrtx_XXXXX. Each `tool_result` block must have a corresponding `tool_use`
block in the previous message.
```

## Timeline

- Agent uses tools during normal operation
- At some point, the LLM streaming response fails (network error, abort, timeout)
- The assistant message gets `stopReason: "error"` or `stopReason: "aborted"`
- Tool execution may still complete (or have already completed) — `toolResult` messages exist in context
- On the **next prompt call**, the corrupted state causes a `400` from the API
- The agent becomes stuck in a loop: every subsequent prompt hits the same `400`
- Only workaround: delete the session and restart

## Root Cause

The bug is in `@mariozechner/pi-ai` → `providers/transform-messages.js` → `transformMessages()`.

### The Problematic Code

```javascript
// Second pass: insert synthetic empty tool results for orphaned tool calls
const result = [];
let pendingToolCalls = [];
let existingToolResultIds = new Set();

for (let i = 0; i < transformed.length; i++) {
    const msg = transformed[i];
    
    if (msg.role === "assistant") {
        // ...
        
        // Skip errored/aborted assistant messages entirely.
        const assistantMsg = msg;
        if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
            continue;  // ← SKIPS the assistant (and its tool_use blocks)
        }
        
        // Track tool calls from this assistant message
        const toolCalls = assistantMsg.content.filter(b => b.type === "toolCall");
        if (toolCalls.length > 0) {
            pendingToolCalls = toolCalls;
            existingToolResultIds = new Set();
        }
        result.push(msg);
    }
    else if (msg.role === "toolResult") {
        existingToolResultIds.add(msg.toolCallId);
        result.push(msg);  // ← ALWAYS PUSHED, even if the assistant was skipped!
    }
}
```

### What Happens

1. **Normal flow:** Assistant message has `toolCall` blocks → subsequent `toolResult` messages reference those tool call IDs → Anthropic API sees matching pairs → ✅

2. **Error flow:**
   - Assistant message gets `stopReason: "error"` → `continue` skips it
   - The assistant's `toolCall` blocks are **removed** from the output
   - But the corresponding `toolResult` messages are **kept** in the output
   - The `toolResult` now references a `tool_use_id` that doesn't exist in any preceding assistant message
   - Anthropic API receives orphaned `tool_result` → **400 Bad Request**

### Message Flow Example

**Before `transformMessages`:**
```
[0] user:      "Search for X"
[1] assistant: [toolCall{id:"toolu_ABC", name:"web_search"}]  stopReason:"error"
[2] toolResult: {toolCallId:"toolu_ABC", content:"search results..."}
[3] user:      "Try again"
```

**After `transformMessages`:**
```
[0] user:      "Search for X"
                                    ← assistant SKIPPED (errored)
[1] toolResult: {toolCallId:"toolu_ABC", ...}   ← ORPHANED! No preceding tool_use
[2] user:      "Try again"
```

**Anthropic API receives:**
```json
{
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "Search for X"}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_ABC", ...}]},
    {"role": "user", "content": [{"type": "text", "text": "Try again"}]}
  ]
}
```
→ **400: `messages.1.content.0: unexpected tool_use_id found in tool_result blocks: toolu_ABC`**

## Why Our Fixes Didn't Help

### Fix 1: `sanitizeToolUseResultPairing` in `context.ts` (PR #143)
- Runs on **our** `Message` format (`role: "tool_result"`)
- Operates **before** `toAgentMessage()` conversion
- Correctly strips orphaned tool_results at our layer
- But `transformMessages` runs **after** `convertToLlm`, in a different layer
- The orphan is created by `transformMessages` itself (by skipping errored assistants)
- So our sanitize runs on clean data, then `transformMessages` re-creates the orphan

### Fix 2: `findSafeSplitIndex` backward check (PR #143)
- Only affects compaction split boundaries
- Unrelated to this bug

## Why Session Files Look Clean

The JSONL session files only contain text-type messages because:
1. The Discord transport stores messages via `sessionStore.addMessage()`
2. Only user messages and final assistant text responses are persisted
3. Tool calls happen inside the SDK's agent loop and are never written to the JSONL
4. The corruption exists only in the SDK's in-memory `_state.messages`
5. After `clearMessages()` + fresh `prompt()`, the messages should be clean
6. But `transformMessages` re-corrupts them by skipping errored assistants from previous turns that got carried into the new prompt context

## Fix (in `pi-ai`)

When skipping an errored/aborted assistant message, track its `toolCall` IDs and also skip subsequent `toolResult` messages that reference those IDs:

```javascript
if (msg.role === "assistant") {
    const assistantMsg = msg;
    if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        // Track tool call IDs from skipped assistant to also skip their results
        const skippedToolCalls = assistantMsg.content.filter(b => b.type === "toolCall");
        for (const tc of skippedToolCalls) {
            skippedToolCallIds.add(tc.id);
        }
        continue;
    }
    // ...
}
else if (msg.role === "toolResult") {
    // Skip tool results that reference skipped (errored) assistant messages
    if (skippedToolCallIds.has(msg.toolCallId)) {
        continue;
    }
    existingToolResultIds.add(msg.toolCallId);
    result.push(msg);
}
```

## Workaround (Isotopes-side)

Until `pi-ai` is fixed, add a `transformContext` hook in `pi-mono.ts` that strips orphaned `toolResult` messages before they reach `convertToLlm`/`transformMessages`:

```typescript
const agent = new Agent({
    transformContext: async (messages) => {
        // Strip toolResult messages that reference non-existent toolCall IDs
        const toolCallIds = new Set<string>();
        for (const msg of messages) {
            if (msg.role === "assistant" && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === "toolCall") toolCallIds.add(block.id);
                }
            }
        }
        return messages.filter(msg => {
            if (msg.role === "toolResult" && !toolCallIds.has(msg.toolCallId)) {
                return false; // Skip orphaned tool results
            }
            return true;
        });
    },
});
```

## Impact

- Every agent error during tool execution corrupts the session permanently
- Session cannot recover without manual deletion + restart
- Observed 5+ occurrences in a single day during active development
- Affects all users of `pi-agent-core` + `pi-ai` with Anthropic provider

## Upstream

- Library: `@mariozechner/pi-ai` v0.64.0
- File: `dist/providers/transform-messages.js`
- GitHub: https://github.com/niclas-nickleby/pi (assumed — verify actual repo)
