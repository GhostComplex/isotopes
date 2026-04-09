# 🔄 M10 — Self-Iteration System PRD

> Version: 0.1.0  
> Date: 2026-04-09  
> Status: **Draft**

## Overview

Enable Isotopes agents to **self-iterate**: update their own system prompt, workspace files, and skills based on learnings from development runs. This implements autonomous self-improvement — agents can reflect on what worked, what didn't, and encode those lessons into their configuration.

## Goals

1. **System prompt iteration** — Agent can modify its own `SOUL.md`, `AGENTS.md`, `TOOLS.md` files
2. **Skill creation** — Agent can create new skills in `{workspace}/skills/`
3. **Skill refinement** — Agent can update existing skills based on experience
4. **Lesson capture** — Agent can append to `MEMORY.md` and daily notes
5. **Safe iteration** — Changes are reviewable before taking effect (optional)

## Non-Goals

- Global skill installation (only workspace-local)
- System prompt changes affecting other agents
- Git commit/push automation (agent already has git tools)

---

## Current State (v0.1.0)

### What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Workspace loading | ✅ | `loadWorkspaceContext()` reads SOUL.md, USER.md, TOOLS.md, AGENTS.md |
| Memory loading | ✅ | MEMORY.md + daily notes in `memory/YYYY-MM-DD.md` |
| Workspace watcher | ✅ | `WorkspaceWatcher` detects file changes with debouncing |
| Config hot-reload | ✅ | `ConfigReloader` watches YAML config changes |
| Git operations | ✅ | `src/tools/git.ts` — status, add, commit, push, diff |
| Skills (M9) | 🔄 In Progress | Discovery, parsing, prompt injection |

### What's Missing

| Feature | Status | Notes |
|---------|--------|-------|
| Write workspace files | ❌ | No API/tool for agent to write back to workspace |
| Skill creation tool | ❌ | Agent can't create new `skills/*/SKILL.md` |
| System prompt reload | ❌ | Changes require restart |
| Reflection trigger | ❌ | No mechanism to prompt agent for self-reflection |
| Diff preview | ❌ | No way to preview changes before applying |

---

## Implementation Plan

### M10.1: Workspace Write API (~100 LOC, S)

Add capability for agent to write workspace files:

**New:** `src/workspace/writer.ts`
```typescript
interface WorkspaceWriteOptions {
  workspacePath: string;
  allowedFiles?: string[]; // Default: SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md, memory/*.md
  backup?: boolean;        // Create .bak before overwrite (default: true)
}

async function writeWorkspaceFile(
  filename: string, 
  content: string, 
  options: WorkspaceWriteOptions
): Promise<void>;

async function appendToMemory(
  content: string,
  options: WorkspaceWriteOptions
): Promise<void>;
```

**Security:**
- Only allow writes to predefined file patterns
- Validate path doesn't escape workspace (no `../`)
- Create backup before overwrite

**Tests:** `src/workspace/writer.test.ts`

---

### M10.2: Self-Iteration Tool (~150 LOC, M)

Expose workspace write as agent tool:

**Tool definition:**
```yaml
name: iterate_self
description: Update your own workspace files (SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md) based on learnings

parameters:
  file:
    type: string
    enum: [SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md]
    description: Which workspace file to update
  action:
    type: string
    enum: [replace, append, patch]
    description: How to apply the change
  content:
    type: string
    description: New content (for replace/append) or patch (for patch)

returns:
  success: boolean
  backup_path: string | null
  message: string
```

**Implementation:** `src/tools/self-iteration.ts`
- Validate agent has `selfIteration: true` in config
- Write to workspace using `writer.ts`
- Return backup path for rollback

---

### M10.3: Skill Creation Tool (~150 LOC, M)

Enable agent to create skills:

**Tool definition:**
```yaml
name: create_skill
description: Create a new skill in your workspace skills directory

parameters:
  name:
    type: string
    description: Skill name (lowercase, hyphenated)
  description:
    type: string
    description: Short description for skill matching
  content:
    type: string
    description: Full SKILL.md content

returns:
  success: boolean
  path: string
  message: string
```

**Implementation:** `src/tools/skill-creator.ts`
- Create `{workspace}/skills/{name}/SKILL.md`
- Validate YAML frontmatter
- Validate name pattern (lowercase, hyphenated)
- Emit event for M9 skill discovery to pick up

---

### M10.4: Reflection Mechanism (~100 LOC, S)

Add structured reflection prompts:

**Config:**
```yaml
agent:
  selfIteration:
    enabled: true
    reflectionTrigger: "on-idle"  # or "on-prompt", "manual"
    reflectionPrompt: |
      Review the recent session. What worked well? What could be improved?
      If you learned something worth encoding into your SOUL.md, AGENTS.md, 
      or a new skill, use the iterate_self or create_skill tools.
```

**Triggers:**
- `on-idle`: After N minutes without messages
- `on-prompt`: Include reflection prompt with every user message (expensive)
- `manual`: Only when user asks "reflect" or similar

**Implementation:** Hook into `AgentRunner` to inject reflection based on trigger config.

---

### M10.5: Hot-Reload System (~200 LOC, M)

Live reload workspace files without restart:

**Implementation:**
1. Hook `WorkspaceWatcher` to detect changes to SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md, skills/*
2. On change, call `AgentManager.reloadWorkspace(agentId)` which:
   - Re-runs `loadWorkspaceContext(workspacePath)`
   - Rebuilds system prompt via `buildSystemPrompt()`
   - Updates the running agent's system prompt in-place
3. For skills: re-run M9 skill discovery and update available skills list
4. Emit `workspace_reloaded` event for logging/debugging

**New methods:**
```typescript
// AgentManager
async reloadWorkspace(agentId: string): Promise<void>;

// Events
interface WorkspaceReloadedEvent {
  type: 'workspace_reloaded';
  agentId: string;
  changedFiles: string[];
  timestamp: Date;
}
```

**CLI:**
- `isotopes reload <agent-id>` — manually trigger reload
- `isotopes reload --all` — reload all agents

---

### M10.6: Integration (~50 LOC, S)

Wire together components:

1. Register `iterate_self` and `create_skill` tools when `selfIteration.enabled: true`
2. Enable workspace watcher by default when `selfIteration.enabled: true`
3. Export types and functions from `src/index.ts`

---

## Config Schema

```yaml
agents:
  - id: isotopes
    name: Isotopes
    workspacePath: /home/steins-ghost/.isotopes/workspace
    selfIteration:
      enabled: true
      allowedFiles:
        - SOUL.md
        - AGENTS.md
        - TOOLS.md
        - MEMORY.md
        - "memory/*.md"
        - "skills/**/*"
      backup: true
      reflectionTrigger: manual  # on-idle | on-prompt | manual
      reflectionPrompt: null     # Custom prompt or use default
```

---

## Acceptance Criteria

1. [ ] Agent can update SOUL.md via `iterate_self` tool
2. [ ] Agent can append to MEMORY.md and daily notes
3. [ ] Agent can create new skills via `create_skill` tool
4. [ ] Backup files created before overwrites (`.bak`)
5. [ ] Path traversal prevented (no `../` escape)
6. [ ] Tool only available when `selfIteration.enabled: true`
7. [ ] Changes take effect immediately via hot-reload (no restart needed)
8. [ ] Unit tests for writer, tools, and security validations

---

## Future Work (not in M10)

- Diff preview tool (show changes before applying)
- Approval workflow (require human approval for self-iteration)
- Metrics tracking (what iterations were made, how often)
- Rollback command (restore from backup)

---

## References

- [OpenClaw SOUL.md pattern](https://docs.openclaw.ai/workspace)
- [AgentSkills Spec](https://agentskills.io/specification)
- [Hermes self-improvement loop](https://github.com/GhostComplex/hermes-agent)
