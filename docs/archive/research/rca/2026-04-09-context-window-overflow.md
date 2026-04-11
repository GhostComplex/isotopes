# RCA: Context Window Overflow (2026-04-09)

## Incident Summary
- **Date:** 2026-04-09 ~14:56 - 16:43 UTC
- **Impact:** Isotopes became unresponsive, repeatedly hitting API limit errors
- **Error:** `prompt token count of 421909 exceeds the limit of 168000`
- **Duration:** ~2 hours

## Root Cause

**The global `compaction` config was not being passed to agents.**

In `src/cli.ts:278`, the `toAgentConfig()` function was called without the 4th parameter (`config.compaction`):

```typescript
// BEFORE (bug)
const agentConfig = toAgentConfig(agentFile, config.provider, config.tools);

// AFTER (fix)
const agentConfig = toAgentConfig(agentFile, config.provider, config.tools, config.compaction);
```

This meant that even though `isotopes.yaml` had:
```yaml
compaction:
  mode: aggressive
  contextWindow: 100000
  threshold: 0.6
```

The agent's `compaction` config was `undefined`, so the compaction feature was **completely disabled**.

## Why It Wasn't Caught Earlier

1. **No log message for disabled compaction** — When compaction is undefined, `pi-mono.ts` silently skips the feature
2. **Test coverage gap** — Unit tests for `toAgentConfig()` tested agent-level compaction overrides, but not the default compaction passthrough in `cli.ts`
3. **Symptom masked as config issue** — Initial troubleshooting focused on adjusting threshold/mode values, not checking if compaction was enabled at all

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 13:33 | First concurrency crash (PR #60 fix applied) |
| 14:56 | First `400 Bad Request` errors appear |
| 15:06 | Compaction config adjusted (aggressive/0.6) — **no effect** |
| 15:25 | Isotopes daemon crashes, subagent orphaned |
| 16:27 | Daemon restarted, but old session still loaded |
| 16:37 | Context hits 358k tokens |
| 16:40 | Steins requests root cause investigation |
| 16:43 | **Bug identified in cli.ts** — missing `config.compaction` parameter |
| 16:43 | Fix applied, build, restart. Log shows: `Context compaction enabled for agent "assistant" (mode: aggressive)` |

## Fix Applied

```diff
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -275,7 +275,7 @@ async function main() {
   // Create agents with workspace tools
   for (const agentFile of config.agents) {
-    const agentConfig = toAgentConfig(agentFile, config.provider, config.tools);
+    const agentConfig = toAgentConfig(agentFile, config.provider, config.tools, config.compaction);
```

## Verification

After fix:
```
[2026-04-09T16:43:19.004Z] [INFO ] [pi-mono] Context compaction enabled for agent "assistant" (mode: aggressive)
```

## Action Items

1. **[Done]** Fix cli.ts to pass `config.compaction` to `toAgentConfig()`
2. **[TODO]** Add integration test: verify agent has compaction config when global config is set
3. **[TODO]** Add log message when compaction is **not** configured (make silent skip visible)
4. **[TODO]** Add overflow recovery: catch `model_max_prompt_tokens_exceeded` error → force compact → retry
5. **[TODO]** Consider adding session size monitoring/alerts

## Lessons Learned

1. **Always check if the feature is actually enabled** before debugging its configuration
2. **Function signatures with many optional parameters are error-prone** — consider using an options object
3. **Silent failures are dangerous** — log when features are disabled, not just when enabled

## Related PRs

- PR #60: Concurrency deadlock fix
- PR #67: Streaming truncation fix
- PR #70 (pending): Compaction config passthrough fix
