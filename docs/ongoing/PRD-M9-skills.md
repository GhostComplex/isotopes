# 🧠 M9 — Skills System PRD

> Version: 0.1.0  
> Date: 2026-04-09  
> Status: **Ongoing**

## Overview

Add a **Skills system** to Isotopes, enabling agents to load task-specific instructions on-demand. Skills are self-contained capability packages with setup scripts, reference docs, and structured instructions.

This implements the [Agent Skills standard](https://agentskills.io/specification).

## Goals

1. **Progressive disclosure** — Only skill descriptions in system prompt; full instructions loaded on-demand
2. **Reusability** — Skills work across agents and workspaces
3. **Compatibility** — Follow AgentSkills spec for interop with other harnesses (Claude Code, Pi, OpenClaw)

## Non-Goals (v1)

- `/skill:name` slash command registration (future)
- `allowed-tools` frontmatter enforcement (future)
- MCP integration (explicitly not needed)
- Remote skill installation (not planned)

---

## Skill Structure

A skill is a directory containing `SKILL.md`:

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts (optional)
│   └── process.sh
├── references/           # Detailed docs loaded on-demand (optional)
│   └── api-reference.md
└── assets/               # Templates, configs (optional)
    └── template.json
```

### SKILL.md Format

```markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific about triggers.
---

# My Skill

## Setup

Run once before first use:
\`\`\`bash
cd /path/to/skill && npm install
\`\`\`

## Usage

\`\`\`bash
./scripts/process.sh <input>
\`\`\`
```

### Frontmatter (Required)

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | Yes | 1-64 chars, lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. Determines when agent loads the skill. |

Skills with missing `description` are **not loaded**.

### Name Rules

- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `web-search`, `github-issues`, `pdf-tools`  
Invalid: `Web-Search`, `-web`, `web--search`

---

## Discovery Locations

Skills are discovered from (in order):

| Location | Scope | Notes |
|----------|-------|-------|
| `~/.isotopes/skills/` | Global | User-wide skills |
| `{workspace}/skills/` | Workspace | Agent-specific skills |

Discovery rules:
- Directories containing `SKILL.md` are discovered recursively
- Root `.md` files (non-directory) are ignored
- First skill wins on name collision (warns but continues)

---

## System Prompt Integration

At agent startup, inject discovered skills as XML block:

```xml
<available_skills>
  <skill>
    <name>web-search</name>
    <description>Search the web using DuckDuckGo. Use when user asks to find information online.</description>
    <location>~/.isotopes/skills/web-search/SKILL.md</location>
  </skill>
  <skill>
    <name>github-issues</name>
    <description>Create, list, and manage GitHub issues. Use for issue triage workflows.</description>
    <location>/home/agent/workspace/skills/github-issues/SKILL.md</location>
  </skill>
</available_skills>
```

Add instruction block before skills XML:

```markdown
## Skills

Before replying, scan <available_skills> descriptions.
- If exactly one skill clearly applies: read its SKILL.md at <location>, then follow it.
- If multiple could apply: choose the most specific one, then read/follow.
- If none apply: proceed without loading any skill.

When a skill references relative paths, resolve them against the skill directory.
```

---

## Loading Flow

```
1. Agent startup
   └── scanSkillDirectories()
       ├── ~/.isotopes/skills/
       └── {workspace}/skills/
       └── For each SKILL.md:
           ├── Parse frontmatter (name, description)
           ├── Validate name matches directory
           └── Add to skills registry

2. Build system prompt
   └── injectSkillsBlock(skills[])
       └── XML block with names, descriptions, locations

3. Agent receives task
   └── Agent decides if skill applies (based on description)
       └── If yes: agent uses read tool to load full SKILL.md
           └── Agent follows instructions, resolving relative paths
```

---

## Implementation

### New Files

```
src/
├── skills/
│   ├── index.ts          # Main exports
│   ├── discovery.ts      # Scan directories, find SKILL.md files
│   ├── parser.ts         # Parse frontmatter, validate
│   └── prompt.ts         # Generate XML block for system prompt
└── skills.test.ts        # Unit tests
```

### Types

```typescript
interface Skill {
  name: string;           // e.g., "web-search"
  description: string;    // From frontmatter
  location: string;       // Absolute path to SKILL.md
  directory: string;      // Parent directory (for relative path resolution)
}

interface SkillRegistry {
  skills: Map<string, Skill>;
  add(skill: Skill): void;
  get(name: string): Skill | undefined;
  all(): Skill[];
}
```

### Integration Points

1. **AgentConfig** — Add optional `skillPaths?: string[]` for additional discovery locations
2. **loadWorkspaceContext()** — Call `discoverSkills()` and store in context
3. **buildSystemPrompt()** — Call `generateSkillsPromptBlock()` to inject XML

### Config (isotopes.yaml)

```yaml
agents:
  defaults:
    skills:
      paths:
        - ~/.isotopes/skills
      # workspace skills auto-discovered from {workspace}/skills/
```

Per-agent override:

```yaml
agents:
  list:
    - id: major
      skills:
        paths:
          - ~/.isotopes/skills
          - ~/custom-skills
```

---

## Validation

| Condition | Behavior |
|-----------|----------|
| Missing `description` | Skill not loaded (error logged) |
| Name doesn't match directory | Warning, skill still loads |
| Name invalid format | Warning, skill still loads |
| Duplicate name | Warning, first wins |
| SKILL.md parse error | Error logged, skill skipped |

---

## Testing

### Unit Tests

- `discovery.test.ts` — Directory scanning, SKILL.md detection
- `parser.test.ts` — Frontmatter parsing, validation
- `prompt.test.ts` — XML generation

### Integration Tests

- Agent loads skill and follows instructions
- Relative path resolution works
- Name collision handling

---

## Acceptance Criteria

1. [ ] Skills discovered from `~/.isotopes/skills/` and `{workspace}/skills/`
2. [ ] SKILL.md frontmatter parsed (name, description)
3. [ ] Skills XML block injected into system prompt
4. [ ] Agent can read full SKILL.md via read tool
5. [ ] Relative paths in skills resolve correctly
6. [ ] Name validation with warnings (not errors)
7. [ ] Duplicate name handling (first wins, warning logged)
8. [ ] Unit tests for discovery, parsing, prompt generation

---

## Future Work (not in M9)

- `/skill:name` command registration
- `allowed-tools` frontmatter enforcement
- Skill versioning and updates
