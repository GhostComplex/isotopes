---
name: coding-agent
description: "Delegate coding tasks to sub-agents via send_message. Use when: (1) building/creating new features, (2) refactoring code, (3) fixing bugs that need multi-file changes, (4) reviewing PRs. Default target: claude. NOT for: simple one-liner fixes (just exec), reading code (use read_file), or tasks that only need shell commands."
---

# Coding Agent

Delegate coding tasks to sub-agents via the `send_message` tool. Always use **claude** as the default target unless it fails — then fall back to a registered named agent.

## Target Priority

1. **claude** — Default. Always try first. Runs the Claude CLI in `working_directory`.
2. **subagent** — Ephemeral helper that inherits your filtered tool set. Use for tasks where claude isn't available or you want the call to share your provider.
3. **Named agents** (e.g. `eous`) — Use when you specifically need that agent's persona / persisted memory.

## When to Use

✅ **USE this skill when:**

- Building or creating new features
- Refactoring large codebases
- Fixing bugs that span multiple files
- Implementing specs or designs
- Reviewing PRs (delegate to claude to analyze diff)
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
send_message(
  to: "claude",
  content: "In /Users/steins.ghost/_repos/isotopes, do X. Details: ...",
  working_directory: "/Users/steins.ghost/_repos/isotopes"
)
```

### Key Rules

1. **Always specify working_directory** — agent wakes up focused on the right project (required for `claude`)
2. **Be specific in `content`** — include file paths, function names, expected behavior
3. **Include constraints** — "don't modify tests", "keep backward compatible", etc.
4. **One concern per call** — don't ask one agent to do 5 unrelated things

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
send_message(
  to: "claude",
  content: "Review PR #XX in /Users/steins.ghost/_repos/isotopes.
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

# 2. Delegate each in its own worktree
send_message(to: "claude", content: "Fix issue #78...", working_directory: "worktrees/issue-78")
send_message(to: "claude", content: "Fix issue #99...", working_directory: "worktrees/issue-99")

# 3. Create PRs after fixes
cd worktrees/issue-78 && git push -u origin fix/issue-78
gh pr create --title "fix: ..." --body "..."

# 4. Cleanup
git worktree remove worktrees/issue-78
```

## Progress Updates

When delegating coding tasks:
- Send 1 short message when you start (what's running + where)
- Update when something changes: milestone completes, error hit, sub-run finishes
- If a sub-run fails, say what failed and why immediately
- If the result returns `[send_message cancelled by user — do not retry…]`, stop. Don't retry the same content.
- If the result returns `[blocked] …`, the failure tracker has shut this task down. Don't retry the same content; ask the user or change approach.

## ⚠️ Rules

1. **Always try `claude` first** — only switch to a named agent if claude fails
2. **Never hand-code patches yourself** — you're an orchestrator, delegate to agents
3. **Be patient** — don't `/stop` sub-runs because they're "slow"; cancellation is recorded and blocks retry
4. **Never delegate code changes against your own workspace** — always against the source repo
5. **Run tests after changes** — `npm run build && npm test` in the repo
6. **One concern per call** — keep `content` focused
