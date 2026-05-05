---
name: coding-agent
description: "Delegate a focused coding task to another agent via the spawn_agent tool. Use for: building features, multi-file refactors, multi-file bug fixes, PR review, writing tests. NOT for: one-liner edits (use edit), reading code (use read), running shell commands (use bash)."
---

# Coding Agent

Delegate coding work to another agent with the `spawn_agent` tool. The call blocks until the spawned agent finishes; the return value is its final assistant message.

## Tool

```
spawn_agent(
  to: <target agent id>,
  content: <task description>,
  working_directory: <path, required for `coding`>
)
```

`to` must be one of the targets the tool advertises in its current description. Common conventions:

- **`coding`** — Claude CLI subprocess running in `working_directory`. Default choice for real coding tasks.
- **`subagent`** — ephemeral pi helper with read-only tools. Good for exploration / analysis without side effects.
- **A registered agent id** — appends the prompt to that agent's session as a user turn. Use when you specifically need that agent's persona or memory.

If `to` isn't in the advertised target list, the call fails with `Unknown target`.

## Writing the `content`

- One concern per call. Don't bundle unrelated tasks.
- Be concrete: file paths, function names, expected behavior, validation command.
- State constraints: "don't touch tests", "keep the public API stable", etc.

Template:

```
Task: <what to do>
Files to modify: <if known>
Context: <why>
Constraints:
- <constraint>
Validation: run `pnpm build && pnpm test`
```

## PR review

```
spawn_agent(
  to: "coding",
  content: "Review PR #NN. Run `git diff main...<branch>` and report bugs, missing error handling, test gaps, style issues.",
  working_directory: "/abs/path/to/repo"
)
```

## Parallel work via worktrees

```bash
git worktree add -b fix/issue-78 worktrees/issue-78 main
git worktree add -b fix/issue-99 worktrees/issue-99 main
```

Then spawn one agent per worktree with its own `working_directory`. Push and open PRs after each finishes; remove worktrees when merged.

## Progress updates

- One short message when you start (target + working_directory).
- Update on milestone, error, or completion. No filler.
- If a sub-run returns `[send_message cancelled by user — do not retry…]` or `[blocked] …`, stop. Don't retry the same content; ask the user or change approach.

## Rules

1. You are the orchestrator. Don't hand-write patches yourself when delegation fits.
2. `working_directory` is required for `coding` (sets the Claude subprocess cwd). For pi targets it's passed as task context — use absolute paths in `content` if precision matters.
3. Don't kill sub-runs because they feel slow. Cancellation is recorded and blocks retry.
4. Never delegate edits against your own workspace — always against the source repo.
5. Have the spawned agent run build/tests as part of the task, not as a follow-up call.
