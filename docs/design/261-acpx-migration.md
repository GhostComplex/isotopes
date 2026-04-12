# Design: #261 — Migrate Subagent to Real acpx

## Summary

Replace direct `claude -p --output-format stream-json` with `acpx --format json --approve-all <agent> exec --file -` to enable:
- Multi-agent support (claude, codex, etc.)
- ACP protocol compliance
- Future session management

## Current State

`AcpxBackend` spawns:
```bash
claude -p --output-format stream-json --verbose [--allowedTools ...] [--model ...]
```

Problems:
- Only Claude works despite `ACPX_AGENTS` declaring 8 agents
- Not using ACP protocol at all
- Name "Acpx" is misleading

## Target State

Spawn acpx binary with JSON-RPC streaming:
```bash
acpx --cwd <cwd> --format json --approve-all <agent> exec --file -
```

## acpx JSON-RPC Event Format

Tested on current machine. Key events:

### Message Streaming
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"...",
  "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"chunk"}}
}}
```

### Tool Use Start
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"...",
  "update":{
    "_meta":{"claudeCode":{"toolName":"Bash"}},
    "toolCallId":"toolu_...",
    "sessionUpdate":"tool_call",
    "status":"pending",
    "title":"Terminal",
    "kind":"execute"
  }
}}
```

### Tool Result (completed)
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"...",
  "update":{
    "_meta":{"claudeCode":{"toolName":"Bash","toolResponse":{...}}},
    "toolCallId":"toolu_...",
    "sessionUpdate":"tool_call_update",
    "status":"completed",
    "rawOutput":"..."
  }
}}
```

### Final Result
```json
{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn","usage":{...}}}
```

## Changes

### 1. `buildArgs()` → Acpx Format

Before:
```typescript
buildArgs(options: AcpxSpawnOptions): string[] {
  return ["-p", "--output-format", "stream-json", "--verbose", ...];
}
```

After:
```typescript
buildAcpxArgs(options: AcpxSpawnOptions): { globalArgs: string[], agentArgs: string[] } {
  const globalArgs = [
    "--cwd", options.cwd,
    "--format", "json",
  ];
  if (options.permissionMode === "skip") {
    globalArgs.push("--approve-all");
  }
  const agentArgs = ["exec", "--file", "-"];
  if (options.model) {
    agentArgs.push("--model", options.model);
  }
  if (options.maxTurns !== undefined) {
    agentArgs.push("--max-turns", String(options.maxTurns));
  }
  return { globalArgs, agentArgs };
}
```

Spawn command becomes:
```typescript
spawn("acpx", [...globalArgs, agent, ...agentArgs], { cwd, stdio: ["pipe", "pipe", "pipe"] })
```

### 2. `parseJsonLine()` → ACP JSON-RPC

New parser for session/update notifications:

```typescript
function parseAcpxJsonLine(line: string): AcpxEvent | undefined {
  const obj = JSON.parse(line);
  
  // Skip non-session/update notifications
  if (obj.method !== "session/update") {
    // Check for final result
    if (obj.id !== undefined && obj.result?.stopReason) {
      return { type: "done", exitCode: 0 };
    }
    return undefined;
  }
  
  const update = obj.params?.update;
  if (!update) return undefined;
  
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      const text = update.content?.text;
      return text ? { type: "message", content: text } : undefined;
    
    case "tool_call":
      if (update.status === "pending") {
        return {
          type: "tool_use",
          toolName: update._meta?.claudeCode?.toolName ?? update.title ?? "",
          toolInput: update.rawInput,
        };
      }
      return undefined;
    
    case "tool_call_update":
      if (update.status === "completed") {
        return {
          type: "tool_result",
          toolName: update._meta?.claudeCode?.toolName ?? "",
          toolResult: update.rawOutput ?? "",
        };
      }
      return undefined;
    
    default:
      return undefined;
  }
}
```

### 3. `spawn()` Method

```typescript
async *spawn(taskId: string, options: AcpxSpawnOptions): AsyncGenerator<AcpxEvent> {
  this.validateAgent(options.agent);
  this.validateCwd(options.cwd);
  
  // Check concurrent limit
  if (this.processes.size >= MAX_CONCURRENT_AGENTS) {
    throw new Error(`Max concurrent sub-agents (${MAX_CONCURRENT_AGENTS})`);
  }
  
  // Try acpx first, fallback to claude -p
  let proc: ChildProcess;
  let useAcpx = true;
  
  try {
    const { globalArgs, agentArgs } = this.buildAcpxArgs(options);
    proc = spawn("acpx", [...globalArgs, options.agent, ...agentArgs], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch {
    // Fallback: direct claude -p
    useAcpx = false;
    proc = spawn("claude", this.buildLegacyArgs(options), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  
  // Write prompt to stdin
  proc.stdin?.write(options.prompt);
  proc.stdin?.end();
  
  // Parse stdout lines with appropriate parser
  const parser = useAcpx ? parseAcpxJsonLine : parseLegacyJsonLine;
  // ... streaming logic same as current
}
```

### 4. Fallback Detection

Actually detect if acpx spawn fails (ENOENT or immediate exit):

```typescript
// Listen for spawn error
proc.on("error", (err) => {
  if (err.code === "ENOENT" && useAcpx) {
    // acpx not found — restart with claude -p
    log.warn("acpx not found, falling back to claude -p");
    // Re-spawn with legacy mode
  }
});
```

Better: pre-check acpx availability on AcpxBackend construction.

## Tests

1. **Unit: parseAcpxJsonLine**
   - Message chunk → `{ type: "message", content }`
   - Tool call pending → `{ type: "tool_use", toolName, toolInput }`
   - Tool call completed → `{ type: "tool_result", toolName, toolResult }`
   - Final result → `{ type: "done" }`
   - Initialize/session/new → undefined (ignored)

2. **Unit: buildAcpxArgs**
   - Default → `["--cwd", X, "--format", "json"]` + `["exec", "--file", "-"]`
   - permissionMode skip → includes `--approve-all`
   - model set → `["exec", "--file", "-", "--model", M]`
   - maxTurns set → `["exec", "--file", "-", "--max-turns", N]`

3. **Integration: spawn with acpx**
   - Mock acpx binary
   - Verify events stream correctly
   - Verify prompt passed via stdin

4. **Integration: fallback to claude -p**
   - When acpx not found → uses claude -p
   - Legacy parser used instead

## Files Changed

- `src/subagent/acpx-backend.ts` — Core changes
- `tests/subagent/acpx-backend.test.ts` — New/updated tests

## Acceptance Criteria

- [ ] `spawn_subagent` uses `acpx <agent> exec` by default
- [ ] Claude agent works with new acpx path
- [ ] Streaming to Discord works (agent_message_chunk → message events)
- [ ] Tool use/result events correctly parsed
- [ ] Fallback to `claude -p` if acpx unavailable
- [ ] Existing tests pass or updated

## Not In Scope (P1)

- Session persistence (`acpx <agent> prompt` instead of `exec`)
- Steer capability
- Other agents besides claude (codex etc.) — needs their ACP adapters tested
