# 388 — Sandbox fs bridge (revised)

> Status: design • Issue: [#388](https://github.com/GhostComplex/isotopes/issues/388) • Follow-up to: PR #387 (issue #385)
>
> **History:** an earlier version of this doc proposed a full `Workspace` abstraction with `HostWorkspace` / `SandboxWorkspace` implementations and a contract-test suite. That design was over-engineered for our state — the abstraction premium was paid for hypothetical future backends (SSH, Podman, Firecracker, e2b, …) that aren't on the roadmap. This revision drops the abstraction and adopts the openclaw-style bridge pattern: a single `SandboxFs` chokepoint that file-mutation tools route through when sandboxing is on. About 260 LOC instead of 730. If a second real backend ever lands, refactor toward an interface then — with two real implementations to learn from.

## Background

After PR #387 wired `exec` through the Docker sandbox and mounted `allowedWorkspaces` read-only, we still have an inconsistency:

- `exec` and background processes run inside the container, constrained by the mount boundary.
- `write_file`, `edit`, `list_dir`, `read_file`, `git`, `gh` run on the host fs / via host child processes, constrained only by `resolveWorkspaceConstrainedPath()` (pure-JS validation).

So **the more powerful tool (arbitrary shell) is more sandboxed than the weaker, structured tools**. A prompt-injected agent that fails `exec "cat > /etc/passwd"` can fall back to `write_file("/etc/passwd", ...)` — which only has to defeat one JS path resolver to escape.

Threat model: isotopes accepts messages from public Discord/Feishu channels. Any user in a bound channel can attempt prompt injection. The agent should be treated as untrusted, and the OS — not pure-JS validation — should be the boundary.

## Goals / non-goals

**Goals**
- Close the security asymmetry: file mutations land inside the sandbox container's mount view, not on host fs directly.
- Single chokepoint for fs mutations so adding a new write-tool can't accidentally bypass the sandbox.
- Zero runtime overhead when sandbox is off.

**Non-goals**
- Build a polymorphic backend abstraction. We have one alternate execution venue (Docker). YAGNI applies.
- Route reads through the bridge. Reads have no side effect; the host bind mount already gives a consistent view at zero latency.
- Refactor `exec` / `process_*` routing — PR #387 already handled them.

## Architecture

```
   ┌────────────── BEFORE (PR #387) ────────────┐    ┌────────────── AFTER ──────────────────────┐
   │                                            │    │                                           │
   │  read_file ──► fs.readFile (host)          │    │  read_file ──► fs.readFile (host)         │
   │  list_dir ──► fs.readdir (host)            │    │  list_dir ──► fs.readdir (host)           │
   │                                            │    │                                           │
   │  write_file ─► fs.writeFile (host)         │    │  write_file ─► sandboxFs?.writeFile()     │
   │  edit ──────► fs.writeFile (host)          │    │                  ?? fs.writeFile (host)   │
   │  (no sandbox awareness — bypasses it)      │    │  edit ──────► same                        │
   │                                            │    │                          │                │
   │  exec ──────► sandboxExecutor or host      │    │  exec ──────► (unchanged from #387)       │
   │  process_* ─► ChildProcess                 │    │  process_* ─► (unchanged)                 │
   │                                            │    │                          │                │
   │                                            │    │                          ▼                │
   │                                            │    │                ┌─────────────────┐        │
   │                                            │    │                │   SandboxFs     │        │
   │                                            │    │                │  (only exists   │        │
   │                                            │    │                │   when sandbox  │        │
   │                                            │    │                │   is enabled)   │        │
   │                                            │    │                └────────┬────────┘        │
   │                                            │    │                         │ docker exec     │
   │                                            │    │                         ▼                 │
   │                                            │    │                ContainerManager           │
   └────────────────────────────────────────────┘    └───────────────────────────────────────────┘
```

The bridge is opt-in injection: `cli.ts` constructs a `SandboxFs` only when the agent's `sandbox.mode` says so, and passes it (or `undefined`) to the tool factory. Each fs-write handler checks once at entry. No interface, no second host implementation, no contract tests across backends.

## SandboxFs

```ts
// src/sandbox/fs-bridge.ts (new, ~120 LOC)

export class SandboxFs {
  constructor(
    private executor: SandboxExecutor,
    private agentId: string,
  ) {}

  async writeFile(absPath: string, content: string): Promise<void> {
    // Pipe content via stdin to avoid ARG_MAX. Use sh -c "cat > <quoted path>".
    // Returns ExecResult; non-zero exitCode → throw FsError mapped from stderr.
  }

  async mkdir(absPath: string, opts?: { recursive?: boolean }): Promise<void> {
    // sh -c "mkdir [-p] <quoted path>"
  }

  async unlink(absPath: string): Promise<void> {
    // sh -c "rm <quoted path>"
  }

  async rename(from: string, to: string): Promise<void> {
    // sh -c "mv <quoted from> <quoted to>"
  }
}

export class FsError extends Error {
  constructor(public code: "ENOENT" | "EACCES" | "EEXIST" | "EISDIR" | "EUNKNOWN",
              message: string) { super(message); }
}
```

Notes:
- All paths are absolute host paths. The container mounts at the same paths (see "Mount strategy" below), so no translation.
- `writeFile` content always goes through stdin, never the command line — avoids `ARG_MAX`, avoids quoting bugs. Binary content can be added later via base64; not part of this iteration.
- Stderr parsing maps common patterns (`Permission denied` → `EACCES`, `No such file` → `ENOENT`, etc.) into `FsError.code` so tool error formatting stays uniform.

## Mount strategy change

PR #387 mounts the workspace at `/workspace` and `allowedWorkspaces` at their host paths. That asymmetry forces path translation in any sandbox-routed tool: tool sees host path, container sees `/workspace/...`.

**Change:** mount the workspace at its host path too (`hostPath:hostPath:rw`). After this:
- Tool-visible abs path == host abs path == container-internal abs path.
- `cwd`, log lines, error messages, and `pwd` output all reference the same string inside and outside the container.
- Drop `WORKDIR /workspace` from the Dockerfile. cwd is supplied per-call.

This is a small change (~20 LOC in `container.ts`) but eliminates an entire class of "is this a host path or container path" bugs in the bridge.

## Tool changes

| Tool | Change |
|---|---|
| `read_file` | None. Always host fs (sees container writes via the bind mount). |
| `list_dir` | None. Same reason. |
| `write_file` | One-line entry branch: `await sandboxFs ? sandboxFs.writeFile(p, c) : fs.writeFile(p, c, "utf-8")`. |
| `edit` | Same; also route the `mkdir(parentDir)` call through `sandboxFs.mkdir`. |
| `exec` / `process_*` | Unchanged — PR #387 already routes these. |
| `git` / `gh` | Out of scope for this issue — they shell out via `exec` patterns and would be migrated as a follow-up. |

`createWorkspaceTools` signature gains an optional `sandboxFs?: SandboxFs`. Nothing else changes in the tool factory chain.

`cli.ts` assembly:

```ts
const sandboxFs = sandboxExecutor && shouldSandbox(agentConfig.sandbox, isMainAgent)
  ? new SandboxFs(sandboxExecutor, agentConfig.id)
  : undefined;

const tools = createWorkspaceTools({ ..., sandboxFs });
```

## Path policy

`resolveWorkspaceConstrainedPath()` stays. It runs *before* the sandboxFs branch, on both paths, and serves two purposes:
1. **Defense in depth** for the host path (sandbox off).
2. **Pre-flight rejection** for the sandbox path: paths inside read-only `allowedWorkspaces` mounts are rejected up front for write operations, avoiding a wasted `docker exec` round-trip that would just produce `EACCES`.

So the validator stops being the *only* line of defense (mounts are now the boundary) but stays as a UX optimization.

## Testing

- `fs-bridge.test.ts`: mock `SandboxExecutor`, assert each method generates the expected `docker exec` argv (including stdin pipe for `writeFile`), and that stderr → `FsError.code` mapping covers the documented cases.
- `tools.test.ts`: add cases for `write_file` / `edit` with `sandboxFs` injected, verifying the bridge is called and host `fs.writeFile` is *not*.
- **Behavioral parity test** (one file, ~80 LOC): run the same scripted sequence (mkdir, write, read-back, rename, unlink) through (a) host fs and (b) `SandboxFs` against a real container, asserting the resulting on-disk state is identical. Gated behind `ISOTOPES_SANDBOX_INTEGRATION=1` so CI without Docker skips it. This is the "contract test" — but as one integration test, not a polymorphic interface contract.

## Hardening (separate issue)

These are independent of the bridge and worth landing in a separate small PR:
- Mount blocklist: refuse to mount `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, Docker socket, `/etc /proc /sys /dev` from `allowedWorkspaces` or future user-provided binds.
- Reject `network: host` in sandbox config validation.
- Strip sensitive env vars (`*_TOKEN`, `*_KEY`, `*_SECRET`) when launching the container.

These can ship in parallel with the bridge work.

## Phasing

1. **This issue:** SandboxFs bridge + mount strategy change + migrate `write_file` / `edit`.
2. **Follow-up:** migrate `git` / `gh` to route through the bridge's exec path (or `SandboxExecutor` directly).
3. **Parallel issue:** hardening (mount blocklist + env sanitize + network validation).

## LOC estimate

| Module | New | Modified | Notes |
|---|---|---|---|
| `src/sandbox/fs-bridge.ts` | 120 | — | Bridge + FsError + stderr mapper |
| `src/sandbox/container.ts` | — | 20 | Mount switches to `hostPath:hostPath`; drop `WORKDIR` |
| `src/core/tools.ts` | — | 30 | One-line branch in `write_file` / `edit` handlers |
| `src/cli.ts` | — | 10 | Construct & inject `SandboxFs` |
| Tests (bridge unit + tool branches + integration parity) | 100 | — | |
| `docs/sandbox.md` | — | 30 | Update model description |
| **Total** | **~260 LOC** | | |

vs. ~730 LOC in the prior Workspace-abstraction draft.

## Risks

1. **Mount semantics change** (`hostPath:hostPath` replacing `/workspace`): scripts that hard-code `/workspace` break. We do set `WORKDIR /workspace` in the current Dockerfile — drop it; cwd is provided per-call. Audit any internal docs/examples that reference `/workspace`.
2. **Binary writes** are not supported by `SandboxFs.writeFile(content: string)`. Same limitation as today's `fs.writeFile` path — no regression, but worth documenting.
3. **Stderr mapping is best-effort.** If a future container image emits unexpected error text, we fall back to `FsError("EUNKNOWN", stderr)`. Acceptable; tools see *some* error.
4. **`edit`'s read-modify-write window** is not atomic. It isn't atomic on host either today; the bridge doesn't make it worse.

## Acceptance

- With `sandbox.mode: all`, an agent calling `write_file("/etc/passwd", ...)` fails because `/etc` isn't mounted, regardless of what the JS path validator returns.
- With `sandbox.mode: off`, behavior is identical to today.
- No measurable latency regression for read-heavy tool calls.
- Adding a new fs-mutation tool requires routing through `SandboxFs`; the type checker complains if it's missed (because the handler factory takes `sandboxFs?: SandboxFs` as a documented param).
