# 388 — Workspace abstraction

> Status: design • Issue: [#388](https://github.com/GhostComplex/isotopes/issues/388) • Follow-up to: PR #387 (issue #385)

## Background

After PR #387 wired `exec` through the Docker sandbox and mounted `allowedWorkspaces` read-only, we still have an inconsistency:

- `exec` and background processes run inside the container, constrained by the mount boundary.
- `write_file`, `edit`, `list_dir`, `read_file`, `git`, `gh` run on the host fs / via host child processes, constrained only by `resolveWorkspaceConstrainedPath()` (pure-JS validation).

So **the more powerful tool (arbitrary shell) is more sandboxed than the weaker, structured tools**. A prompt-injected agent that fails `exec "cat > /etc/passwd"` can fall back to `write_file("/etc/passwd", ...)` — which only has to defeat one JS path resolver to escape.

Threat model: isotopes accepts messages from public Discord/Feishu channels. Any user in a bound channel can attempt prompt injection. The agent should be treated as untrusted, and the OS — not pure-JS validation — should be the boundary.

## Goals / non-goals

**Goals**
- Tool implementations are completely sandbox-unaware. They see only a `Workspace` interface.
- Sandbox on/off is decided **only at cli.ts construction time**; the type passed downstream is identical.
- Behavior is semantically consistent across backends (error shape, path resolution, timeout).

**Non-goals**
- Replace git/gh CLI behavior (preserve current; cwd comes from Workspace).
- Network-layer abstraction (web / reply / react / transport stay on host — they don't touch workspace fs).
- Remote / SSH backend (interface is extensible; not implemented this iteration).

## Architecture

```
   ┌────────────── BEFORE ──────────────┐    ┌──────────────── AFTER ────────────────┐
   │                                    │    │                                       │
   │  read_file ──► fs.readFile         │    │  read_file ──┐                        │
   │  write_file ─► fs.writeFile        │    │  write_file ─┤                        │
   │  edit ──────► fs.readFile + write  │    │  edit ───────┤                        │
   │  list_dir ──► fs.readdir           │    │  list_dir ───┼──► Workspace interface │
   │  exec ──────► spawn / docker exec  │    │  exec ───────┤         │              │
   │  process_* ─► ChildProcess         │    │  process_* ──┘         │              │
   │                                    │    │                        │              │
   │  (each tool decides routing,       │    │  (no tool knows about  │              │
   │   sandbox knowledge leaks into     │    │   sandbox)             │              │
   │   exec.ts and tools.ts)            │    │                        ▼              │
   │                                    │    │             ┌──────────────────┐      │
   │                                    │    │             │  HostWorkspace   │      │
   │                                    │    │             │  (sandbox: off)  │      │
   │                                    │    │             └──────────────────┘      │
   │                                    │    │             ┌──────────────────┐      │
   │                                    │    │             │ SandboxWorkspace │      │
   │                                    │    │             │  (sandbox: on)   │      │
   │                                    │    │             └────────┬─────────┘      │
   │                                    │    │                      │                │
   │                                    │    │                      ▼                │
   │                                    │    │             ContainerManager          │
   └────────────────────────────────────┘    └───────────────────────────────────────┘
```

## Workspace interface

```ts
// src/workspace/workspace.ts (new)

export interface Workspace {
  /** Workspace identity — used for logging, error context. */
  readonly id: string;
  /** Root path on host (used by tools to resolve relative inputs). */
  readonly rootPath: string;

  // ── Path policy ─────────────────────────────────────────────────────
  /**
   * Resolve a user-supplied path against the workspace root and validate
   * it lies within rootPath ∪ allowedWorkspaces. Pure JS; identical
   * semantics in both backends. Returns the absolute host-side path.
   */
  resolvePath(input: string, opts?: { mode?: "read" | "write" }): string;

  // ── File ops ────────────────────────────────────────────────────────
  readFile(absPath: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(absPath: string, content: string, encoding?: BufferEncoding): Promise<void>;
  mkdir(absPath: string, opts?: { recursive?: boolean }): Promise<void>;
  unlink(absPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(absPath: string): Promise<{ size: number; isDir: boolean; mtime: Date }>;
  listDir(absPath: string): Promise<{ name: string; isDir: boolean }[]>;

  // ── Exec ────────────────────────────────────────────────────────────
  exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
  spawn(command: string, opts?: { cwd?: string }): SpawnHandle;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnHandle {
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", cb: (code: number | null) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
}
// node:child_process ChildProcess already satisfies SpawnHandle.

export class FsError extends Error {
  constructor(public code: "ENOENT" | "EACCES" | "EEXIST" | "EISDIR" | "EUNKNOWN",
              message: string) { super(message); }
}
```

**Every Workspace method takes an absolute host path.** Path resolution happens once via `resolvePath`, so:
- Tools call `resolvePath` exactly once per operation; error handling is uniform.
- Neither backend duplicates path-validation logic.

## Implementations

### HostWorkspace (~120 LOC)
- `readFile / writeFile / ...` → `node:fs/promises` directly.
- `exec` → `child_process.exec` + timeout.
- `spawn` → `child_process.spawn("sh", ["-c", cmd], {cwd})`.
- Error normalization: `NodeJS.ErrnoException` → `FsError`.

### SandboxWorkspace (~200 LOC)
- Holds `SandboxExecutor` + `agentId`.
- **Mount strategy change (key):** workspace is no longer mounted at `/workspace`. Instead, **mount at the same path as the host** (`hostPath:hostPath:rw`). Reasons:
  - Tool-visible abs path = host abs path = container-internal abs path; zero translation.
  - `allowedWorkspaces` already follows this style — unify.
  - `cwd` / log / error messages mean the same string inside and outside the container.
- `readFile`: `fs.readFile` directly (via host bind mount, zero latency).
- `writeFile`: `docker exec sh -c "cat > <path>"`, content piped via stdin to avoid `ARG_MAX`; binary uses base64.
- `mkdir / unlink / rename`: `docker exec sh -c "mkdir -p / rm / mv ..."`.
- `stat / listDir`: via host mount (read-only).
- `exec`: delegates to `sandboxExecutor.execute(agentId, ["sh","-c",cmd], {timeout})`.
- `spawn`: `child_process.spawn(...await sandboxExecutor.buildExecArgv(...))`. Returned `ChildProcess` natively satisfies `SpawnHandle`.
- Error normalization: parse container stderr / exit code → `FsError`.

**Reads via mount, writes via `docker exec`** is an internal optimization, transparent to tools — they only call `workspace.readFile`, never knowing.

## Tool migration (~150 LOC net)

| Tool | Change |
|---|---|
| `read_file` | `fs.readFile` → `workspace.readFile(workspace.resolvePath(p, {mode:"read"}))` |
| `write_file` | Same, write path |
| `edit` | read + write both via workspace; `mkdir` likewise |
| `list_dir` | `fs.readdir` → `workspace.listDir` |
| `exec` (tool) | Delete the internal `useSandbox()` branch; single path via `workspace.exec / workspace.spawn` |
| `process_*` | Unchanged — registry now holds `SpawnHandle` (was `ChildProcess`); same shape |
| `git / gh` | Use `workspace.exec`; auto-follows sandbox |

`createWorkspaceTools` / `createExecTools` signatures simplify:

```ts
// before
createExecTools({ cwd, registry, sandboxExecutor, agentId, isMainAgent,
                  agentSandboxConfig, allowedWorkspaces })

// after
createExecTools({ workspace, registry })
```

cli.ts assembly site:

```ts
const workspace: Workspace = sandboxExecutor &&
  shouldSandbox(agentConfig.sandbox, isMainAgent)
    ? new SandboxWorkspace({ id: agentConfig.id, rootPath: workspacePath,
                             allowedWorkspaces, executor: sandboxExecutor })
    : new HostWorkspace({ id: agentConfig.id, rootPath: workspacePath,
                          allowedWorkspaces });

const tools = [
  ...createWorkspaceTools({ workspace }),
  ...createExecTools({ workspace, registry: processRegistry }),
  ...createGitTools({ workspace }),
  ...createGithubTools({ workspace }),
];
```

Below this line, no code knows about sandboxes.

## Error model

All errors that reach a tool are `FsError` (with code) or `ExecError`. Container-stderr-parsed failures and host `fs.*` errno-throws are normalized at the Workspace layer to the same exception shape. Tool `catch` branches do not need two implementations.

## Testing strategy

- `host-workspace.test.ts` / `sandbox-workspace.test.ts`: mock the bottom layer (`fs` / `ContainerManager`); each method × happy + error.
- `workspace-contract.test.ts`: a **single** test suite exercised against both implementations, enforcing behavioral parity. **This is the linchpin** — without contract tests, the two implementations drift.
- Existing `tools.test.ts` / `exec.test.ts`: mock `Workspace`; stop mocking `fs`.

## Phasing

1. **Phase 1 (this issue):** define interface + both implementations + contract tests + migrate `read_file / write_file / edit / list_dir / exec / process_*`.
2. **Phase 2:** migrate `git / gh`.
3. **Phase 3 (separate issue):** mount blocklist + env sanitize + `network: host` rejection. Logically independent; can run in parallel.

## LOC estimate (with abstraction)

| Module | New | Modified | Notes |
|---|---|---|---|
| `src/workspace/workspace.ts` (interface + FsError) | 60 | — | |
| `src/workspace/host-workspace.ts` | 120 | — | |
| `src/workspace/sandbox-workspace.ts` | 200 | — | Includes stderr → FsError normalization |
| `src/sandbox/container.ts` | — | 20 | Mount switches to `hostPath:hostPath` |
| `src/sandbox/executor.ts` | — | 10 | Surface for SandboxWorkspace |
| `src/core/tools.ts` (tool migration) | — | 80 | Net change small; mostly `fs.*` → `workspace.*` |
| `src/tools/exec.ts` | — | 60 | Drop sandbox branch; single path |
| `src/tools/git.ts` + `github.ts` | — | 40 | Use workspace.exec |
| `src/cli.ts` | — | 25 | Workspace assembly |
| Tests: contract + 2 impls + tool updates | 350 | — | Contract test is biggest, highest-value piece |
| `docs/sandbox.md` rewrite | — | 50 | |
| **Total** | **~730 LOC** | | |

About 300 LOC more than the prior "wire `docker exec` directly into existing tool handlers" plan. Most of the delta is the abstraction layer and contract tests. **What those 300 LOC buy: tool code never leaks sandbox concepts, future fs / exec tools work correctly by default, and a new backend (remote / SSH / alternative container runtime) is a single new Workspace implementation.**

## Risks

1. **Mount semantics change** (`hostPath:hostPath` replacing `/workspace`): scripts inside the container that hard-code `/workspace` break. We currently set `WORKDIR /workspace` in the Dockerfile — drop it; cwd is provided per-call.
2. **Binary files:** `writeFile(content: string)` does not yet support binary. This continues the current limitation; no new restriction introduced.
3. **Contract-test design cost:** must precisely define "the two implementations must agree on what" (e.g., `ENOENT` error message text is not required identical, but the `code` is). Land with ~15 invariants.
4. **Path-permission split:** `resolvePath({mode: "write"})` in SandboxWorkspace must reject paths inside read-only `allowedWorkspaces` mounts up front — not wait for container `EACCES`. Avoids a wasted `docker exec` round-trip.

## Acceptance

- With `sandbox.mode: all`, an agent calling `write_file("/etc/passwd", ...)` fails because `/etc` isn't mounted, regardless of what the JS path validator returns.
- With `sandbox.mode: off`, behavior is identical to today (HostWorkspace path).
- No measurable latency regression for read-heavy tool calls.
- Tool source code contains zero references to `SandboxExecutor` or `docker`.
