# M8: Subagent Security & Discord Integration

> Version: 0.1.0  
> Date: 2026-04-09  
> Status: **Planning**  
> Related PR: [#57](https://github.com/GhostComplex/isotopes/pull/57)

## Overview

PR #57 introduces Claude CLI integration for subagent spawning and Discord thread streaming. This PRD documents the security and quality improvements needed before merge, based on combined review findings from OPC multi-role review and Claude Code's built-in review.

## Background

### Current State (PR #57)

- Migrated from `acpx` CLI to native `claude` CLI
- Added `--dangerously-skip-permissions` for non-interactive approval
- Hardcoded tool whitelist: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `LS`
- Added `SubagentDiscordContext` via AsyncLocalStorage for Discord streaming
- Implemented prompt queueing in `PiMonoInstance`
- Moved `threadBindings` config from top-level to under `discord` section

### Review Consensus

Both reviews (OPC + Claude Code) agree on:

| Finding | OPC | Claude Code |
|---------|-----|-------------|
| Permission bypass should be configurable | Yes | Yes |
| Config schema needs update | Yes | Yes |
| Test coverage is insufficient | Yes | Not mentioned |
| Tool whitelist should be configurable | Yes | Not mentioned |

---

## Requirements

### 8.1 Configurable Permission Model

**Priority: Critical**

The `--dangerously-skip-permissions` flag is currently unconditional. This must be configurable.

#### Config Schema

```yaml
acp:
  subagent:
    # Permission mode for subagent tool execution
    # - "skip" — Use --dangerously-skip-permissions (full access, no prompts)
    # - "allowlist" — Use --allowedTools with configured list (recommended)
    # - "default" — Use claude CLI defaults (interactive prompts, not suitable for automation)
    permissionMode: allowlist  # skip | allowlist | default
    
    # Tool whitelist (only used when permissionMode: allowlist)
    # Default: safe file tools without shell access
    allowedTools:
      - Read
      - Write
      - Edit
      - Glob
      - Grep
    
    # Enable shell access (adds Bash to allowedTools)
    # WARNING: Combined with permissionMode: skip, this allows arbitrary command execution
    enableShell: false
```

#### Implementation

```typescript
// src/subagent/acpx-backend.ts
buildArgs(options: AcpxSpawnOptions): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];

  switch (options.permissionMode) {
    case "skip":
      args.push("--dangerously-skip-permissions");
      break;
    case "allowlist":
      if (options.allowedTools?.length) {
        args.push("--allowedTools", ...options.allowedTools);
      }
      break;
    case "default":
      // No permission flags — use claude CLI defaults
      break;
  }

  return args;
}
```

#### Acceptance Criteria

- [ ] `permissionMode` config option with three modes
- [ ] `allowedTools` config option for whitelist mode
- [ ] `enableShell` convenience flag (adds Bash to allowlist)
- [ ] Default to `allowlist` mode without Bash
- [ ] Log warning when `permissionMode: skip` is used
- [ ] Log warning when `enableShell: true` is combined with `permissionMode: skip`

---

### 8.2 Config Schema Update

**Priority: High**

Update `DiscordConfig` type to include `threadBindings` and subagent streaming options.

#### Type Definition

```typescript
// src/core/config.ts
export interface DiscordConfig {
  tokenEnv?: string;
  token?: string;
  defaultAgentId?: string;
  allowDMs?: boolean;
  channelAllowlist?: string[];
  agentBindings?: Record<string, string>;
  
  // Thread bindings (moved from top-level)
  threadBindings?: {
    enabled?: boolean;
    spawnAcpSessions?: boolean;
  };
  
  // Subagent streaming options
  subagentStreaming?: {
    enabled?: boolean;        // Default: true
    showToolCalls?: boolean;  // Default: true
  };
}
```

#### Migration

- [ ] Add deprecation warning if top-level `threadBindings` is detected
- [ ] Auto-migrate: copy top-level `threadBindings` to `discord.threadBindings`
- [ ] Document breaking change in CHANGELOG

---

### 8.3 Path Validation Hardening

**Priority: Medium**

Improve workspace path validation to handle edge cases.

#### Current Issues

1. `validateCwd` uses `normalize()` instead of `realpath()` — symlinks can escape
2. No validation that subagent file tools respect workspace bounds (relies on `--dangerously-skip-permissions` behavior)

#### Implementation

```typescript
// src/subagent/acpx-backend.ts
import { realpathSync } from "node:fs";

validateCwd(cwd: string): void {
  // Resolve symlinks to prevent escape
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // Path doesn't exist yet — fall back to normalize
    resolved = normalize(resolve(cwd));
  }
  
  // ... existing validation logic with resolved path
}
```

#### Acceptance Criteria

- [ ] Use `realpathSync` when path exists
- [ ] Fall back to `normalize(resolve())` for non-existent paths
- [ ] Add test for symlink escape attempt

---

### 8.4 Test Coverage

**Priority: High**

Add tests for critical untested paths.

#### Missing Tests

| Component | Gap | Priority |
|-----------|-----|----------|
| `runSubagentWithDiscord` | Zero coverage (85 lines) | Critical |
| `createSubagentTool` handler | Agent validation, path resolution untested | Critical |
| Claude CLI format parsing | `assistant`, `user`, `result` events untested | Critical |
| Prompt queue edge cases | Error handling, 3+ concurrent prompts | Medium |
| Path traversal | Symlink attacks, `..` segments | Medium |

#### New Test Files

```
src/core/tools.test.ts          # createSubagentTool, runSubagentWithDiscord
src/subagent/claude-format.test.ts  # Claude CLI JSON parsing
```

#### Acceptance Criteria

- [ ] `runSubagentWithDiscord` has tests for:
  - [ ] Successful completion with Discord thread
  - [ ] Error handling (subagent failure)
  - [ ] Sink cleanup on error
- [ ] `createSubagentTool` has tests for:
  - [ ] Agent validation (invalid agent returns error message)
  - [ ] Path resolution (relative `working_directory`)
  - [ ] Context detection (Discord vs plain mode)
- [ ] Claude CLI format parsing has tests for:
  - [ ] `assistant` type with nested `message.content`
  - [ ] `user` type with `tool_result` blocks
  - [ ] `result` type with `subtype: "error_max_turns"`
- [ ] Prompt queue has tests for:
  - [ ] First prompt rejection doesn't block second
  - [ ] 3+ concurrent prompts serialize correctly

---

### 8.5 Backend Singleton Fix

**Priority: Medium**

Fix `getBackend()` to properly handle workspace configuration changes.

#### Current Bug

```typescript
// src/tools/subagent.ts
function getBackend(allowedWorkspaces?: string[]): AcpxBackend {
  if (!sharedBackend || allowedWorkspaces) {  // BUG: truthy check, not value comparison
    sharedBackend = new AcpxBackend(allowedWorkspaces);
  }
  return sharedBackend;
}
```

Empty array `[]` is truthy, causing unnecessary backend recreation.

#### Fix

```typescript
function getBackend(allowedWorkspaces?: string[]): AcpxBackend {
  const workspacesKey = allowedWorkspaces?.sort().join(":") ?? "";
  if (!sharedBackend || sharedBackend.workspacesKey !== workspacesKey) {
    sharedBackend = new AcpxBackend(allowedWorkspaces);
    sharedBackend.workspacesKey = workspacesKey;
  }
  return sharedBackend;
}
```

---

### 8.6 Discord Channel Binding

**Priority: Low**

Harden Discord channel ID handling in subagent context.

#### Current Issue

`sendMessage` and `createThread` accept arbitrary `channelId`, which could be exploited if event handlers are careless.

#### Recommendation

```typescript
// Option A: Validate channelId matches context
private createSubagentContext(channel: SendableChannel): SubagentDiscordContext {
  const boundChannelId = channel.id;
  return {
    sendMessage: async (channelId: string, content: string) => {
      if (channelId !== boundChannelId && !channelId.startsWith("thread-")) {
        throw new Error(`Channel ID mismatch: expected ${boundChannelId}, got ${channelId}`);
      }
      // ... existing logic
    },
    // ...
  };
}

// Option B: Remove channelId parameter entirely (breaking change)
// Only allow sending to the bound channel
```

---

## Implementation Order

| Phase | Tasks | Blocking |
|-------|-------|----------|
| **Phase 1** | 8.1 Permission model, 8.2 Config schema | Yes — security critical |
| **Phase 2** | 8.4 Test coverage (critical paths) | Yes — quality gate |
| **Phase 3** | 8.3 Path validation, 8.5 Backend fix | No |
| **Phase 4** | 8.4 Test coverage (edge cases), 8.6 Channel binding | No |

---

## Appendix: Review Summary

### OPC Multi-Role Review

| Role | Verdict | Key Findings |
|------|---------|--------------|
| Backend | ITERATE | Config migration undocumented, `getBackend()` state bug |
| Security | ITERATE | Permission bypass unconditional, Bash in whitelist |
| Tester | ITERATE | Critical paths untested |

### Claude Code Review

| Finding | Severity |
|---------|----------|
| `--dangerously-skip-permissions` should be configurable | Medium |
| `DiscordConfig` schema needs `threadBindings` | Medium |
| `approveAll` option is ignored | Medium |
| Prompt queueing implementation is correct | N/A (positive) |

### Consensus

Both reviews agree PR should **ITERATE** before merge. Primary blockers:

1. Make permission bypass configurable (security)
2. Update config types (correctness)
3. Add test coverage for new code paths (quality)
