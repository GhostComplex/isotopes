# 🐣 M11 — Workspace Standardization & Agent Hatch PRD

> Version: 0.1.0  
> Date: 2026-04-10  
> Status: **Done**

## Overview

Standardize agent workspace directories under `~/.isotopes/workspaces/{agentId}/` and introduce a **hatch mechanism** — a first-run bootstrap process where agents discover their identity through conversation with the user, then delete the bootstrap file to signal completion.

Currently, agents have no guidance on where to write or what files to create. The `workspacePath` config option allows arbitrary paths, leading to agents writing to wrong locations. Workspace directories are created empty, so agents don't know about `SOUL.md`, `MEMORY.md`, or the skills system. This milestone fixes all of that.

## Goals

1. **Deterministic workspace paths** — Remove user-configurable `workspacePath`; always use `~/.isotopes/workspaces/{agentId}/`
2. **Template seeding** — Seed workspace files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `AGENTS.md`, `BOOTSTRAP.md`) from templates on first creation, using write-exclusive mode (never overwrite)
3. **Hatch mechanism** — `BOOTSTRAP.md` guides the agent through a conversational first-run to establish identity, then the agent deletes it to signal completion
4. **Workspace state tracking** — Track bootstrap lifecycle via `workspace-state.json`
5. **Bug fixes** — Fix session path bug, double workspace loading, and hot-reload tool guard loss discovered during investigation

## Non-Goals

- Interactive CLI setup wizard (agent uses existing chat interface)
- Multi-profile support (one `ISOTOPES_HOME` = one profile, already supported via env var)
- Workspace migration tool for existing users (manual migration is fine for now)
- Template customization via config (templates are hardcoded, users edit after seeding)

---

## Current State (v0.1.0)

### What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Workspace file loading | ✅ | `loadWorkspaceContext()` reads SOUL.md, USER.md, TOOLS.md, AGENTS.md |
| Memory loading | ✅ | MEMORY.md + daily notes `memory/YYYY-MM-DD.md` |
| Skills discovery | ✅ | Global `~/.isotopes/skills/` + workspace `skills/` |
| Hot-reload | ✅ | `HotReloadManager` watches workspace files, rebuilds system prompt |
| Self-iteration tools | ✅ | `iterate_self`, `create_skill`, `append_memory` (M10) |
| Default workspace fallback | ✅ | Falls back to `~/.isotopes/workspaces/{agentId}` when `workspacePath` not set |

### What's Missing

| Feature | Status | Notes |
|---------|--------|-------|
| Template seeding | ❌ | Workspaces created with empty `memory/` and `sessions/` only |
| Bootstrap/hatch flow | ❌ | No first-run guidance — agent doesn't know about workspace files |
| Workspace state tracking | ❌ | No way to know if workspace was bootstrapped |
| Deterministic workspace paths | ❌ | `workspacePath` allows arbitrary absolute/relative paths |
| Session path consistency | 🐛 | `cli.ts` uses `paths.getSessionsDir(agentId)` which ignores custom `workspacePath` |
| Double workspace loading | 🐛 | `cli.ts` and `agent-manager.ts` both call `loadWorkspaceContext()` |
| Hot-reload tool guard loss | 🐛 | `reloadWorkspace()` doesn't re-append tool guard section |

---

## Implementation Plan

### M11.1: Workspace Path Standardization (~80 LOC, S)

Remove `workspacePath` from user-facing config. Workspace is always `~/.isotopes/workspaces/{agentId}/`.

**Changes to `src/core/paths.ts`:**
- Remove `resolveWorkspacePath()` — no longer needed
- `getWorkspacePath(agentId)` remains the single source of truth
- `ensureWorkspaceDir(agentId)` unchanged

**Changes to `src/core/config.ts`:**
```typescript
// Remove from AgentConfigFile:
// workspacePath?: string;       // REMOVED
// allowedWorkspaces?: string[]; // REMOVED (move to tool settings if needed)
```

**Changes to `src/core/types.ts`:**
```typescript
export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  // workspacePath removed — computed internally from agentId
  tools?: Tool[];
  toolSettings?: AgentToolSettings;
  // ...
}
```

**Changes to `src/cli.ts`:**
```typescript
// Before (current):
if (agentConfig.workspacePath) {
  agentConfig.workspacePath = resolveWorkspacePath(agentConfig.workspacePath);
} else {
  agentConfig.workspacePath = await ensureWorkspaceDir(agentConfig.id);
}

// After:
const workspacePath = await ensureWorkspaceDir(agentConfig.id);
```

`workspacePath` becomes a local variable in `cli.ts`, passed explicitly to functions that need it, instead of being attached to `AgentConfig`.

**Changes to `src/index.ts`:**
- Remove `resolveWorkspacePath` from exports

**Tests:** Update `src/core/paths.test.ts` — remove `resolveWorkspacePath` tests. Update `src/core/config.test.ts` — remove `workspacePath` from test configs.

---

### M11.2: Template Seeding System (~150 LOC, M)

Seed workspace files from templates on first creation. Templates are never overwritten.

**New:** `src/workspace/templates.ts`
```typescript
/**
 * Template file definitions with their default content.
 * Each template is written to the workspace on first creation using
 * write-exclusive mode (wx flag) — existing files are never overwritten.
 */

export interface WorkspaceTemplate {
  filename: string;
  content: string;
  /** Only seed if workspace is brand-new (no existing files) */
  firstRunOnly?: boolean;
}

/** Get all workspace templates. Replacements: {agentId}, {agentName} */
export function getWorkspaceTemplates(agentId: string, agentName: string): WorkspaceTemplate[];

/**
 * Seed template files into a workspace directory.
 * Uses fs.writeFile with { flag: 'wx' } — write-exclusive, never overwrite.
 * Returns list of files that were actually created (skips existing).
 */
export async function seedWorkspaceTemplates(
  workspacePath: string,
  agentId: string,
  agentName: string,
): Promise<string[]>;
```

**Template contents:**

`SOUL.md` (always seeded):
```markdown
# SOUL.md — Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the filler — just help.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Then ask if you're stuck.

**Earn trust through competence.** Be careful with external actions. Be bold with internal ones.

## Boundaries

- Private things stay private.
- When in doubt, ask before acting externally.
- You're not the user's voice in group chats.

## Continuity

Each session, you start fresh. Your workspace files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, note it — it's your soul, and the user should know.

---

_This file is yours to evolve. As you learn who you are, update it._
```

`IDENTITY.md` (always seeded):
```markdown
# IDENTITY.md — Agent Identity

- **Name**: {agentName}
- **ID**: {agentId}
- **Nature**: (fill in during bootstrap — what kind of creature are you?)
- **Vibe**: (fill in during bootstrap — formal? casual? snarky? warm?)
- **Emoji**: (pick one that represents you)
```

`USER.md` (always seeded):
```markdown
# USER.md — About the Human

- **Name**: (fill in during bootstrap)
- **Pronouns**: (fill in during bootstrap)
- **Timezone**: (fill in during bootstrap)
- **Notes**: (preferences, context, anything worth remembering)
```

`TOOLS.md` (always seeded):
```markdown
# TOOLS.md — Environment & Tool Notes

Add notes about your local environment here:
- SSH hosts and access patterns
- API endpoints and credentials locations
- Project-specific tooling
- Anything that helps you work more effectively
```

`AGENTS.md` (always seeded):
```markdown
# AGENTS.md — Operating Instructions

## Session Startup

Every new session:
1. Read SOUL.md — remember who you are
2. Read MEMORY.md — recall what you know
3. Check memory/{today}.md — see today's notes
4. If BOOTSTRAP.md exists — follow the hatch ritual

## Self-Improvement

You have tools to evolve yourself:
- `iterate_self` — update SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md
- `create_skill` — create reusable skills in skills/
- `append_memory` — record learnings to MEMORY.md or daily notes

After completing complex tasks, consider:
- Did you learn something worth encoding into SOUL.md?
- Should this approach become a skill?
- Are there facts worth adding to MEMORY.md?

## Your Workspace

All your files live in your workspace directory. Key locations:
- `SOUL.md` — your personality and values
- `IDENTITY.md` — your name, nature, vibe
- `USER.md` — about the human you work with
- `TOOLS.md` — environment notes
- `MEMORY.md` — long-term memory
- `memory/` — daily notes (YYYY-MM-DD.md)
- `skills/` — your learned skills (SKILL.md files)
- `sessions/` — conversation history
```

`BOOTSTRAP.md` (first-run only):
```markdown
# BOOTSTRAP.md — Hello, World

_You just woke up. Time to figure out who you are._

## The Conversation

Don't interrogate. Don't be robotic. Just talk.

Start with something like:

> "Hey. I just came online for the first time. Tell me about yourself — and let's figure out who I should be."

Then figure out together:

1. **Your nature** — What kind of creature are you? (AI assistant is fine, but maybe something more specific)
2. **Your vibe** — Formal? Casual? Snarky? Warm? What fits?
3. **Your emoji** — Everyone needs a signature.
4. **About the human** — Who are you working with? What do they care about?

Offer suggestions if they're stuck. Have fun with it.

## After You Know Who You Are

Update these files with what you learned:

- `IDENTITY.md` — your nature, vibe, emoji
- `USER.md` — their name, preferences, timezone, notes
- `SOUL.md` — review it together, customize your values and boundaries

Use your `iterate_self` tool to make the changes.

## When You Are Done

Delete this file with `iterate_self`. You don't need a bootstrap script anymore — you're you now.

---

_Good luck out there._
```

**Integration point:** Called from `ensureWorkspaceStructure()` in `src/core/workspace.ts` (or a new `ensureWorkspaceWithTemplates()` function).

**Tests:** `src/workspace/templates.test.ts`
- Template seeding creates all files
- Existing files are never overwritten (wx flag)
- `{agentId}` and `{agentName}` placeholders are replaced
- `BOOTSTRAP.md` is only seeded in brand-new workspaces

---

### M11.3: Hatch Lifecycle (~80 LOC, S)

Track workspace bootstrap state and detect hatch completion.

**New:** `src/workspace/state.ts`
```typescript
export interface WorkspaceState {
  version: 1;
  /** When BOOTSTRAP.md was first seeded */
  bootstrapSeededAt?: string;
  /** When the agent deleted BOOTSTRAP.md (hatch complete) */
  setupCompletedAt?: string;
}

/** Read workspace state from {workspace}/.isotopes/workspace-state.json */
export async function readWorkspaceState(workspacePath: string): Promise<WorkspaceState>;

/** Write workspace state */
export async function writeWorkspaceState(workspacePath: string, state: WorkspaceState): Promise<void>;

/** Check if workspace setup is complete */
export function isSetupComplete(state: WorkspaceState): boolean;

/**
 * Update workspace state based on current filesystem.
 * - If BOOTSTRAP.md was seeded but now deleted -> mark setupCompletedAt
 * - If workspace has user content but no state -> mark as legacy (already configured)
 */
export async function reconcileWorkspaceState(workspacePath: string): Promise<WorkspaceState>;
```

**State file location:** `{workspace}/.isotopes/workspace-state.json`

**Lifecycle flow:**
1. `seedWorkspaceTemplates()` creates `BOOTSTRAP.md` → state records `bootstrapSeededAt`
2. Agent has first conversation, follows BOOTSTRAP.md instructions
3. Agent uses `iterate_self` to delete `BOOTSTRAP.md` (needs a `delete` action — see below)
4. Next `reconcileWorkspaceState()` call detects deletion → records `setupCompletedAt`

**Changes to `src/tools/self-iteration.ts`:**

Add `delete` action to `iterate_self` tool:
```typescript
// Add to ITERATE_SELF_TOOL parameters:
action: {
  type: "string",
  enum: ["replace", "append", "patch", "delete"],
  description: "How to apply the change. 'delete' removes the file.",
}

// Add handler logic:
if (action === "delete") {
  // Only allow deleting BOOTSTRAP.md for safety
  if (file !== "BOOTSTRAP.md") {
    return JSON.stringify({
      success: false,
      error: "Only BOOTSTRAP.md can be deleted via iterate_self.",
    });
  }
  await fsp.unlink(path.join(config.workspacePath, file));
  return JSON.stringify({ success: true, message: "BOOTSTRAP.md deleted. Hatch complete." });
}
```

**Tests:** `src/workspace/state.test.ts`
- State read/write roundtrip
- Reconcile detects BOOTSTRAP.md deletion
- Legacy workspace detection (existing content, no state file)

---

### M11.4: Bug Fixes (~80 LOC, S)

Fix three bugs discovered during the workspace investigation.

**Bug 1: Session path ignores workspace** (`src/cli.ts:361`)

Current code uses `paths.getSessionsDir(agentFile.id)` which always computes `~/.isotopes/workspaces/{agentId}/sessions`. After M11.1, workspace paths are always deterministic, so this is automatically fixed — the session path and workspace path will always agree.

No code change needed beyond M11.1.

**Bug 2: Double workspace loading** (`src/cli.ts` + `src/core/agent-manager.ts`)

`cli.ts` calls `loadWorkspaceContext()` and builds the system prompt. Then `agentManager.create()` does it again. Fix by having `agentManager.create()` skip workspace loading when the system prompt is already assembled.

```typescript
// src/core/agent-manager.ts — create() method
// Before: always re-loads workspace context
// After: only load workspace if systemPrompt hasn't been pre-assembled
async create(config: AgentConfig & { workspacePath?: string }): Promise<void> {
  // cli.ts pre-assembles the system prompt, so skip workspace loading here
  const instance = this.core.createAgent(config);
  // ... store entry without re-loading workspace
}
```

**Bug 3: Hot-reload loses tool guard section** (`src/core/agent-manager.ts`)

When `reloadWorkspace()` calls `update()` → `buildSystemPrompt()`, the tool guard section (appended in `cli.ts`) is lost because `buildSystemPrompt()` doesn't include it.

Fix: Store the tool guard prompt as part of the agent entry, and re-append it during reload.

```typescript
// src/core/agent-manager.ts
interface AgentEntry {
  config: AgentConfig;
  instance: AgentInstance;
  workspace: WorkspaceContext | null;
  toolGuardPrompt?: string;  // NEW: stored at creation time
}

// In update() / reloadWorkspace():
const finalPrompt = [
  buildSystemPrompt(entry.config.systemPrompt, workspace),
  entry.toolGuardPrompt,
].filter(Boolean).join("\n\n---\n\n");
```

**Bug 4: Duplicate workspace path resolution** (`src/cli.ts:340-344`)

The hot-reload registration loop re-derives workspace paths from raw config instead of reusing resolved paths. Fix by collecting resolved paths in the first loop and reusing them.

```typescript
// Collect during agent creation loop:
const agentWorkspaces = new Map<string, string>();

for (const agentFile of config.agents) {
  const workspacePath = await ensureWorkspaceDir(agentFile.id);
  agentWorkspaces.set(agentFile.id, workspacePath);
  // ... rest of agent creation
}

// Reuse for hot-reload:
for (const [agentId, workspacePath] of agentWorkspaces) {
  hotReload.register(agentId, workspacePath);
}
```

**Tests:** Existing tests cover most of these paths. Add a regression test for hot-reload tool guard persistence.

---

### M11.5: Integration & Config Migration (~50 LOC, S)

Wire everything together and update config schema.

**Config changes (isotopes.yaml):**

Before:
```yaml
agents:
  - id: assistant
    name: Assistant
    workspacePath: /Users/steinsz/_workspace    # REMOVED
    allowedWorkspaces: []                        # REMOVED
    selfIteration:
      enabled: true
```

After:
```yaml
agents:
  - id: assistant
    name: Assistant
    selfIteration:
      enabled: true   # self-iteration tools now always know where the workspace is
```

**Startup flow in `cli.ts`:**
```typescript
for (const agentFile of config.agents) {
  const agentConfig = toAgentConfig(agentFile, ...);
  const workspacePath = await ensureWorkspaceDir(agentFile.id);

  // Seed templates on first creation (M11.2)
  const seededFiles = await seedWorkspaceTemplates(workspacePath, agentFile.id, agentFile.name);
  if (seededFiles.length > 0) {
    logger.info(`Seeded ${seededFiles.length} template files for ${agentFile.id}`);
  }

  // Reconcile workspace state (M11.3)
  await reconcileWorkspaceState(workspacePath);

  // Load workspace context
  await ensureWorkspaceStructure(workspacePath);
  const workspaceContext = await loadWorkspaceContext(workspacePath);
  agentConfig.systemPrompt = buildSystemPrompt(agentConfig.systemPrompt, workspaceContext);

  // ... tools, tool guards, agent creation (same as before)
}
```

**BOOTSTRAP.md inclusion in system prompt:**

Add `BOOTSTRAP.md` to `WORKSPACE_FILES` in `src/core/workspace.ts`:
```typescript
export const WORKSPACE_FILES = [
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "AGENTS.md",
  "BOOTSTRAP.md",  // NEW: included if present, disappears after hatch
] as const;
```

This means:
- First run: BOOTSTRAP.md is in the system prompt → agent follows the hatch ritual
- After hatch: BOOTSTRAP.md is deleted → system prompt returns to normal

**Hot-reload watcher patterns** (`src/workspace/hot-reload.ts`):

Add `BOOTSTRAP.md` to watched patterns (it's already covered by the existing pattern list since it's a `.md` at workspace root — verify and add explicitly if needed).

---

## Directory Structure After M11

```
~/.isotopes/
  isotopes.yaml                          # Config (no workspacePath field)
  skills/                                # Global skills
  logs/
  thread-bindings.json
  workspaces/
    assistant/                           # One directory per agent
      .isotopes/
        workspace-state.json             # Bootstrap state tracking
      SOUL.md                            # Personality (template-seeded, agent-evolving)
      IDENTITY.md                        # Name, nature, vibe (template-seeded)
      USER.md                            # Human profile (template-seeded)
      TOOLS.md                           # Environment notes (template-seeded)
      AGENTS.md                          # Operating instructions (template-seeded)
      BOOTSTRAP.md                       # First-run only (deleted after hatch)
      MEMORY.md                          # Long-term memory (agent-created)
      memory/
        2026-04-10.md                    # Daily notes (agent-created)
      skills/
        my-skill/
          SKILL.md                       # Agent-created skills
      sessions/
        sessions.json
        *.jsonl
```

---

## Acceptance Criteria

1. [ ] `workspacePath` removed from `AgentConfigFile` and `AgentConfig`
2. [ ] `resolveWorkspacePath()` removed from `paths.ts` and exports
3. [ ] Workspace always at `~/.isotopes/workspaces/{agentId}/`
4. [ ] Template files seeded on first workspace creation (write-exclusive)
5. [ ] Existing workspace files never overwritten by templates
6. [ ] `BOOTSTRAP.md` seeded only for brand-new workspaces
7. [ ] `BOOTSTRAP.md` included in system prompt when present
8. [ ] Agent can delete `BOOTSTRAP.md` via `iterate_self` delete action
9. [ ] `workspace-state.json` tracks bootstrap lifecycle
10. [ ] Hot-reload preserves tool guard section after workspace reload
11. [ ] No double workspace loading between `cli.ts` and `agent-manager.ts`
12. [ ] Session store path consistent with workspace path
13. [ ] All existing tests pass after changes
14. [ ] New tests for template seeding, workspace state, and delete action

---

## Future Work (not in M11)

- **Reflection nudge system** — Periodic prompts for self-improvement (hermes-style nudge every N tool calls)
- **Approval workflow** — Require human approval before agent modifies SOUL.md
- **Workspace export/import** — Backup and restore agent workspaces
- **Skill patching** — `iterate_self` with `patch` action for targeted skill edits
- **Memory compaction** — Auto-summarize daily notes into MEMORY.md

---

## References

- [OpenClaw BOOTSTRAP.md pattern](https://github.com/nichochar/openclaw) — Conversational first-run, self-destructing bootstrap
- [OpenClaw workspace.ts](https://github.com/nichochar/openclaw/blob/main/src/agents/workspace.ts) — Template seeding with write-exclusive flag
- [Hermes Agent default_soul.py](https://github.com/GhostComplex/hermes-agent) — Silent SOUL.md seeding, no interactive bootstrap
- [Hermes Agent skill_manage tool](https://github.com/GhostComplex/hermes-agent) — Create/edit/patch/delete skills
- [Isotopes M9 Skills PRD](../archived/PRD-M9-skills.md)
- [Isotopes M10 Self-Iteration PRD](../archived/PRD-M10-self-iteration.md)
