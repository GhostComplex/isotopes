# 388 — Sandbox fs bridge (revised v2)

> Status: design • Issue: [#388](https://github.com/GhostComplex/isotopes/issues/388) • Follow-up to: PR #387 (issue #385)
>
> **History**
> - **v1** proposed a full `Workspace` abstraction with `HostWorkspace` / `SandboxWorkspace` implementations and a contract-test suite (~730 LOC). Over-engineered for our state — the abstraction premium was paid for hypothetical future backends (SSH, Podman, Firecracker, e2b, …) that aren't on the roadmap. Dropped.
> - **v2** proposed a `SandboxFs` bridge with `if (sandboxFs) sandboxFs.write() else fs.write()` branches at every fs-mutation tool (~260 LOC). Smaller, but had a footgun: any new fs-write tool that forgot the if-branch would silently bypass the sandbox. TypeScript wouldn't catch it.
> - **v3 (this doc)** keeps the bridge but eliminates the if-branch via a duck-typed `FsLike` interface that both `node:fs/promises` and `SandboxFs` satisfy. Tools take `FsLike` and call its methods — no host vs. sandbox decision at the tool layer. Same ~260 LOC, no footgun.

## Background

After PR #387 wired `exec` through the Docker sandbox and mounted `allowedWorkspaces` read-only, we still have an inconsistency:

- `exec` and background processes run inside the container, constrained by the mount boundary.
- `write_file`, `edit`, `list_dir`, `read_file`, `git`, `gh` run on the host fs / via host child processes, constrained only by `resolveWorkspaceConstrainedPath()` (pure-JS validation).

So **the more powerful tool (arbitrary shell) is more sandboxed than the weaker, structured tools**. A prompt-injected agent that fails `exec "cat > /etc/passwd"` can fall back to `write_file("/etc/passwd", ...)` — which only has to defeat one JS path resolver to escape.

Threat model: isotopes accepts messages from public Discord/Feishu channels. Any user in a bound channel can attempt prompt injection. The agent should be treated as untrusted, and the OS — not pure-JS validation — should be the boundary.

## Goals / non-goals

**Goals**
- Close the security asymmetry: file mutations land inside the sandbox container's mount view, not on host fs directly.
- Make sandbox routing **un-forgettable**: adding a new fs-write tool must not be able to silently bypass the sandbox.
- Zero runtime overhead when sandbox is off.

**Non-goals**
- Build a polymorphic backend abstraction. We have one alternate execution venue (Docker). YAGNI applies.
- Route reads through a bridge. Reads have no side effect; the host bind mount already gives a consistent view at zero latency.
- Refactor `exec` / `process_*` routing — PR #387 already handled them, and exec lives in one tool file (no ramification risk).

## Architecture

```
   ┌────────────── BEFORE (PR #387) ────────────┐    ┌────────────────── AFTER ──────────────────┐
   │                                            │    │                                           │
   │  read_file ──► fs.readFile (host)          │    │  read_file  ─┐                            │
   │  list_dir ──► fs.readdir (host)            │    │  list_dir   ─┤                            │
   │                                            │    │  write_file ─┼──► fsImpl: FsLike          │
   │  write_file ─► fs.writeFile (host)         │    │  edit       ─┘     │                      │
   │  edit ──────► fs.writeFile (host)          │    │                    │                      │
   │  (no sandbox awareness — bypasses it)      │    │  injected by cli.ts as one of:            │
   │                                            │    │                    │                      │
   │  exec ──────► sandboxExecutor or host      │    │      ┌─────────────┴─────────────┐        │
   │  process_* ─► ChildProcess                 │    │      │                           │        │
   │                                            │    │  node:fs/promises          SandboxFs      │
   │                                            │    │  (sandbox: off)            (sandbox: on)  │
   │                                            │    │                                  │        │
   │                                            │    │                                  │ docker │
   │                                            │    │                                  ▼  exec  │
   │                                            │    │                          ContainerManager │
   │                                            │    │                                           │
   │                                            │    │  exec / process_* ─► (unchanged from #387)│
   └────────────────────────────────────────────┘    └───────────────────────────────────────────┘
```

The key move: tools no longer import `node:fs/promises` directly. They take an `FsLike` parameter at construction. `cli.ts` decides which implementation to inject. Tool handlers contain **zero** sandbox-related branches.

## The FsLike type and SandboxFs

```ts
// src/sandbox/fs-bridge.ts (new)

import type * as nodeFs from "node:fs/promises";

/**
 * The subset of node:fs/promises that workspace tools use. node:fs/promises
 * naturally satisfies this; SandboxFs is shaped to match. Tools depend only
 * on this type, not on either concrete implementation.
 */
export type FsLike = Pick<
  typeof nodeFs,
  "readFile" | "writeFile" | "mkdir" | "unlink" | "rename" | "stat" | "readdir"
>;

/**
 * Sandbox-routed fs implementation. Mutations (write/mkdir/unlink/rename)
 * go through `docker exec` on the agent's container; reads (readFile/readdir/
 * stat) pass through to node:fs/promises directly because the container's
 * mutations are visible on the host via the bind mount and reads have no
 * side effects to confine.
 */
export class SandboxFs implements FsLike {
  constructor(
    private executor: SandboxExecutor,
    private agentId: string,
  ) {}

  // Reads — passthrough to host fs (writes by the container are visible via
  // the bind mount; nothing to confine).
  readFile = nodeFs.readFile;
  readdir  = nodeFs.readdir;
  stat     = nodeFs.stat;

  // Writes — routed through `docker exec`.
  async writeFile(absPath, content, options?) {
    // sh -c "cat > <quoted path>"; content via stdin to avoid ARG_MAX.
  }
  async mkdir(absPath, options?)  { /* sh -c "mkdir [-p] <quoted>" */ }
  async unlink(absPath)           { /* sh -c "rm <quoted>" */ }
  async rename(from, to)          { /* sh -c "mv <quoted> <quoted>" */ }
}

export class FsError extends Error {
  constructor(public code: "ENOENT" | "EACCES" | "EEXIST" | "EISDIR" | "EUNKNOWN",
              message: string) { super(message); }
}
```

Notes:
- `node:fs/promises` itself satisfies `FsLike` — there is **no** `HostFs` class. The host implementation is just the standard library module.
- All paths are absolute host paths. The container mounts at the same paths (see "Mount strategy" below), so no translation.
- `writeFile` content always goes through stdin, never the command line — avoids `ARG_MAX`, avoids quoting bugs. Binary content can be added later via base64; not part of this iteration.
- Stderr parsing maps common patterns (`Permission denied` → `EACCES`, `No such file` → `ENOENT`, etc.) into `FsError.code` so tool error formatting stays uniform regardless of which implementation produced the error.

## Why FsLike instead of just SandboxFs + if-branches

The earlier draft (v2) had tool handlers do:

```ts
if (sandboxFs) await sandboxFs.writeFile(p, c);
else           await fs.writeFile(p, c, "utf-8");
```

That works but creates a real footgun: a new fs-write tool added later can call `fs.writeFile` directly and the type checker won't object. The sandbox is then silently bypassed.

With `FsLike`, the only way to write is to receive an `FsLike` and call its methods. There is no separate "host path" for tool authors to forget. cli.ts is the single place that picks an implementation; everything below it is uniform.

This is the same property the v1 `Workspace` abstraction provided, achieved without inventing a new interface or writing a `HostWorkspace` class — `node:fs/promises` already has the shape we need.

## Mount strategy change

PR #387 mounts the workspace at `/workspace` and `allowedWorkspaces` at their host paths. That asymmetry forces path translation in any sandbox-routed tool: tool sees host path, container sees `/workspace/...`.

**Change:** mount the workspace at its host path too (`hostPath:hostPath:rw`). After this:
- Tool-visible abs path == host abs path == container-internal abs path.
- `cwd`, log lines, error messages, and `pwd` output all reference the same string inside and outside the container.
- Drop `WORKDIR /workspace` from the Dockerfile; cwd is supplied per-call.

Small change (~20 LOC in `container.ts`) but eliminates an entire class of "is this a host path or container path" bugs in the bridge.

## Tool changes

| Tool | Change |
|---|---|
| `read_file` | `fs.readFile(...)` → `fsImpl.readFile(...)`. Identical at runtime when sandbox is off; falls through to host fs when on. |
| `list_dir` | Same — `fs.readdir` → `fsImpl.readdir`. |
| `write_file` | `fs.writeFile(...)` → `fsImpl.writeFile(...)`. |
| `edit` | Same; also route the `fs.mkdir(parentDir, { recursive: true })` call through `fsImpl.mkdir`. |
| `exec` / `process_*` | Unchanged — PR #387 already routes these. |
| `git` / `gh` | Out of scope here — they shell out via `exec` patterns and would migrate as a follow-up. |

`createWorkspaceTools` signature gains a single required `fsImpl: FsLike` parameter. Each tool handler picks `fsImpl` out of its closure and uses it instead of importing `fs`.

`cli.ts` assembly:

```ts
import * as nodeFs from "node:fs/promises";

const fsImpl: FsLike = sandboxExecutor && shouldSandbox(agentConfig.sandbox, isMainAgent)
  ? new SandboxFs(sandboxExecutor, agentConfig.id)
  : nodeFs;

const tools = createWorkspaceTools({ ..., fsImpl });
```

## Why exec stays separate

The exec tool already has a single sandbox routing decision (`useSandbox()` in `exec.ts`), and there is exactly **one** exec tool. The "forgetting" failure mode that motivated `FsLike` doesn't apply: a future contributor can't accidentally bypass the sandbox by adding a new shell tool because we don't add new shell tools — we add fs tools. So leaving exec on its current direct routing is fine. If we ever do add a second shell-style tool, we can introduce an `ExecLike` symmetrically.

## Path policy

`resolveWorkspaceConstrainedPath()` stays. It runs *before* any `fsImpl` call and serves two purposes:
1. **Defense in depth** for the host path (sandbox off — JS validation is still the only line).
2. **Pre-flight rejection** for the sandbox path: paths inside read-only `allowedWorkspaces` mounts are rejected up front for write operations, avoiding a wasted `docker exec` round-trip that would just produce `EACCES`.

So the validator stops being the *only* line of defense (mounts are now the boundary when sandbox is on) but stays as a UX optimization.

## Testing

- `fs-bridge.test.ts`: mock `SandboxExecutor`, assert each `SandboxFs` write method generates the expected `docker exec` argv (including stdin pipe for `writeFile`), and that stderr → `FsError.code` mapping covers the documented cases. Reads (`readFile` etc.) are simply passthroughs to `node:fs` — assert by spying.
- `tools.test.ts`: switch the mock from `vi.mock("node:fs/promises", ...)` to passing a mock `FsLike`. Assertions become "the tool called `fsImpl.writeFile` with these args" — clearer, and incidentally proves no tool reaches around `fsImpl` to import `fs` directly.
- **Behavioral parity test** (one file, ~80 LOC, gated behind `ISOTOPES_SANDBOX_INTEGRATION=1`): run the same scripted sequence (mkdir, write, read-back, rename, unlink) through (a) `node:fs/promises` and (b) `SandboxFs` against a real container, asserting the resulting on-disk state is identical. This is the "contract test" — but as one integration test, not a polymorphic interface contract.

## Hardening (separate issue)

Independent of the bridge, worth landing in a separate small PR:
- Mount blocklist: refuse to mount `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, Docker socket, `/etc /proc /sys /dev` from `allowedWorkspaces` or future user-provided binds.
- Reject `network: host` in sandbox config validation.
- Strip sensitive env vars (`*_TOKEN`, `*_KEY`, `*_SECRET`) when launching the container.

Can ship in parallel with the bridge work.

## Phasing

1. **This issue:** `FsLike` type + `SandboxFs` + mount strategy change + migrate `read_file` / `write_file` / `edit` / `list_dir` to take `fsImpl`.
2. **Follow-up:** migrate `git` / `gh` to route their shell calls through `SandboxExecutor`.
3. **Parallel issue:** hardening (mount blocklist + env sanitize + network validation).

## LOC estimate

| Module | New | Modified | Notes |
|---|---|---|---|
| `src/sandbox/fs-bridge.ts` | 130 | — | `FsLike` type + `SandboxFs` class + `FsError` + stderr mapper |
| `src/sandbox/container.ts` | — | 20 | Mount switches to `hostPath:hostPath`; drop `WORKDIR` |
| `src/core/tools.ts` | — | 30 | Each fs-touching handler takes `fsImpl` from closure instead of `import * as fs` |
| `src/cli.ts` | — | 10 | Construct & inject `fsImpl` |
| Tests (bridge unit + tool migration + integration parity) | 100 | — | |
| `docs/sandbox.md` | — | 30 | Update model description |
| **Total** | **~270 LOC** | | |

vs. ~730 LOC in v1 (Workspace abstraction) and ~260 LOC in v2 (bridge with if-branches). v3 adds ~10 LOC over v2 for the `FsLike` type definition; in exchange, the if-branches and the forgetting footgun disappear.

## Risks

1. **Mount semantics change** (`hostPath:hostPath` replacing `/workspace`): scripts that hard-code `/workspace` break. Drop `WORKDIR /workspace` from the Dockerfile; cwd is supplied per-call. Audit any internal docs/examples that reference `/workspace`.
2. **Binary writes** are not supported by `SandboxFs.writeFile(content: string)`. Same limitation as today's `fs.writeFile` path — no regression, but worth documenting.
3. **`FsLike` shape drift**: if `node:fs/promises` adds an overload we depend on, `SandboxFs` must match. Since `FsLike` is `Pick<typeof nodeFs, ...>`, the types stay tied — `SandboxFs implements FsLike` will fail to compile if it diverges. So the risk is bounded to "we adopt a new fs method in tools and forget to add it to SandboxFs" — and that surfaces immediately as a type error in `cli.ts` when assigning `new SandboxFs(...)` to `FsLike`.
4. **Stderr mapping is best-effort.** If a future container image emits unexpected error text, we fall back to `FsError("EUNKNOWN", stderr)`. Acceptable; tools see *some* error.
5. **`edit`'s read-modify-write window** is not atomic. It isn't atomic on host either today; the bridge doesn't make it worse.

## Acceptance

- With `sandbox.mode: all`, an agent calling `write_file("/etc/passwd", ...)` fails because `/etc` isn't mounted, regardless of what the JS path validator returns.
- With `sandbox.mode: off`, behavior is identical to today (`fsImpl === node:fs/promises`).
- No measurable latency regression for read-heavy tool calls.
- A grep for `from "node:fs/promises"` or `import.*fs.*promises` returns zero matches in `src/core/tools.ts` after the migration. (Lint rule could enforce this for `src/core/tools.ts` and any new fs tool files, blocking the bypass route at CI.)
