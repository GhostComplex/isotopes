---
name: coding-agent
description: "Delegate coding tasks to sub-agents via spawn_subagent. Use when: (1) building/creating new features, (2) refactoring code, (3) fixing bugs that need multi-file changes, (4) reviewing PRs. Default agent: claude. NOT for: simple one-liner fixes (just exec), reading code (use read_file), or tasks that only need shell commands."
---

# Coding Agent

Delegate coding tasks to sub-agents via `spawn_subagent`. Always use **claude** as the default agent unless it fails — then fall back to codex or gemini.

## Agent Priority

1. **claude** — Default. Always try first.
2. **codex** — Fallback if claude fails or hangs.
3. **gemini** — Secondary fallback.

## When to Use

✅ **USE this skill when:**

- Building or creating new features
- Refactoring large codebases
- Fixing bugs that span multiple files
- Implementing specs or designs
- Reviewing PRs (spawn agent to analyze diff)
- Writing tests

## When NOT to Use

❌ **DON'T use this skill when:**

- Simple one-liner fixes → just use `exec` with sed/patch
- Reading/exploring code → use `read_file` or `exec cat`
- Running tests or builds → use `exec` directly
- Git operations → use `exec` with git commands

## The Pattern

### One-Shot Task

```
spawn_subagent(
  agent: "claude",
  task: "In /Users/steins.ghost/_repos/isotopes, do X. Details: ...",
  working_directory: "/Users/steins.ghost/_repos/isotopes"
)
```

### Key Rules

1. **Always specify working_directory** — agent wakes up focused on the right project
2. **Be specific in the task** — include file paths, function names, expected behavior
3. **Include constraints** — "don't modify tests", "keep backward compatible", etc.
4. **One concern per spawn** — don't ask one agent to do 5 unrelated things

### Task Template

```
Task: [what to do]
Working directory: [path]
Files to modify: [list specific files if known]
Context: [why we're doing this]
Constraints:
- [constraint 1]
- [constraint 2]
Validation: Run `npm run build` and `npm test` after changes.
```

## PR Review Pattern

```
spawn_subagent(
  agent: "claude",
  task: "Review PR #XX in /Users/steins.ghost/_repos/isotopes.
    Run: git diff main...feat/branch-name
    Check for: bugs, missing error handling, test coverage, style issues.
    Summarize findings.",
  working_directory: "/Users/steins.ghost/_repos/isotopes"
)
```

## Parallel Work with Git Worktrees

For fixing multiple issues in parallel:

```bash
# 1. Create worktrees
git worktree add -b fix/issue-78 worktrees/issue-78 main
git worktree add -b fix/issue-99 worktrees/issue-99 main

# 2. Spawn agents in each
spawn_subagent(agent: "claude", task: "Fix issue #78...", working_directory: "worktrees/issue-78")
spawn_subagent(agent: "claude", task: "Fix issue #99...", working_directory: "worktrees/issue-99")

# 3. Create PRs after fixes
cd worktrees/issue-78 && git push -u origin fix/issue-78
gh pr create --title "fix: ..." --body "..."

# 4. Cleanup
git worktree remove worktrees/issue-78
```

## Progress Updates

When spawning coding agents:
- Send 1 short message when you start (what's running + where)
- Update when something changes: milestone completes, error hit, agent finishes
- If agent fails, say what failed and why immediately

## ⚠️ Rules

1. **Always spawn claude first** — only switch agent if claude fails
2. **Never hand-code patches yourself** — you're an orchestrator, delegate to agents
3. **Be patient** — don't kill agents because they're "slow"
4. **Never spawn agents in your own workspace** (your own workspace directory) for code changes — always in the source repo
5. **Run tests after changes** — `npm run build && npm test` in the repo
6. **One concern per agent spawn** — keep tasks focused
