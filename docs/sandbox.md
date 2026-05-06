# Sandbox

Isotopes can route the `exec` tool's shell commands through Docker containers
instead of running them directly on the host. Each agent gets its own
container, lazily created on first command and reused across calls.

## When to enable

- You don't fully trust an agent (or its skills/MEMORY contents) to run shell
  commands on your host.
- You want to limit blast radius of `rm -rf`, `curl | sh`, accidental `git
  push --force`, etc.
- You want resource caps (CPU / memory / PID count) per agent.

## Build the image

```sh
docker build -t isotopes-sandbox:latest docker/sandbox/
```

The default image (`isotopes-sandbox:latest`) ships `git`, `gh`, `curl`,
`jq`, `ripgrep`, and Node.js 20 on Debian Bookworm slim, running as a
non-root `agent` user with uid 1000.

## Configure

Sandbox config can live in three places (in order of precedence — later wins):

1. **Top-level `sandbox:`** — simplest, applies to all agents.
2. **`agents.defaults.sandbox:`** — same effect as top-level but scoped under
   `agents`. Use this when you also have `agents.defaults.tools` etc.
3. **Per-agent `agents.list[].sandbox:`** — partial override for one agent
   (typically just `enabled: false` to opt out, or `enabled: true` to opt in).

Per-agent overrides may set `enabled`, `workspaceAccess`, `mounts` (per-agent mounts are appended to base mounts), and `docker` (per-field merge — agent fields override base fields).

```yaml
# Simplest form — top-level, applies to every agent
sandbox:
  enabled: true
  workspaceAccess: rw          # rw | ro
  docker:
    image: isotopes-sandbox:latest
    network: bridge            # bridge | host | none
    cpuLimit: 1.5
    memoryLimit: 1g
    pidsLimit: 256             # 0 disables
    noNewPrivileges: true

agents:
  list:
    - id: trusted-bot
      sandbox:
        enabled: false         # this one runs on the host
    - id: untrusted-bot
      # inherits the top-level sandbox config
```

## What's mounted

The agent's workspace directory is bind-mounted at the **same host path**
inside the container, so absolute paths resolve identically on host and in
the container. Extra `mounts:` entries are bind-mounted at their declared
container path (read-only when `readOnly: true`).

## What's sandboxed

When `sandbox.enabled` is true:

- **Shell commands** (`exec`, background processes) run as `docker exec` on
  the agent's container.
- **File mutations** (`write_file`, `edit`) are routed through `docker exec`
  via `SandboxFs` (see `src/sandbox/fs-bridge.ts`). They land inside the
  container's mount view, so any path that isn't bind-mounted (`/etc/passwd`,
  `~/.ssh/...`, etc.) cannot be written even if the JS path validator could
  be tricked into accepting it.
- **File reads** (`read_file`, `list_dir`) pass through to host fs directly.
  The bind mount makes the container's writes immediately visible on the
  host, so a `docker exec` round-trip would add latency without confining
  anything (reads have no side effect).

The mechanism is a duck-typed `FsLike` interface that both `node:fs/promises`
and `SandboxFs` satisfy. Tools take `fsImpl: FsLike` and call its methods —
they have no awareness of host vs. sandbox. `cli.ts` is the single place
that picks the implementation per agent.

## What's NOT sandboxed: subagents

Subagent runners (`ClaudeRunner` spawning the Claude Code CLI, `BuiltinRunner`
running in-process) execute on the host and would bypass the sandbox boundary
entirely. To avoid this escape, **`spawn_subagent` is not registered for
sandboxed agents** — the tool simply does not exist in their tool list.

If you need a coding CLI inside the sandbox, build a custom image that
includes it and point `sandbox.docker.image` at the new tag. Recommended
naming convention: `isotopes-sandbox-<cli>` (e.g. `isotopes-sandbox-claude`),
so it composes with the base image namespace and aligns with any
prebuilt images we may ship later (see issue #451):

```dockerfile
# Dockerfile.claude
FROM isotopes-sandbox:latest
USER root
RUN npm install -g @anthropic-ai/claude-code
USER agent
```

```bash
docker build -t isotopes-sandbox-claude:latest -f Dockerfile.claude .
```

```yaml
# isotopes.yaml
sandbox:
  docker:
    image: isotopes-sandbox-claude:latest
```

Then exec into the running container (containers are named
`isotopes-sandbox-<agent-id>` — see `src/sandbox/executor.ts`):

```bash
docker exec -it isotopes-sandbox-<agent-id> claude
```

Credentials must be mounted into the container (e.g. via `docker.binds`) —
they are not forwarded from the host automatically.

## Verifying

After enabling and building the image:

1. Trigger any agent → ask it to run `whoami` and `cat /etc/os-release`.
   You should see `agent` and `Debian`, not your host user / macOS.
2. Stop isotopes (Ctrl+C). `docker ps -a | grep isotopes-sandbox-` should
   be empty — `SandboxExecutor.cleanup()` runs in the SIGINT/SIGTERM
   handlers.

## Limits / not yet supported

- Image is not auto-built; you build it once.
- No automatic uid:gid mapping from the host user — the image's `agent` uid
  is hard-coded to 1000. If your host user uses a different uid, edit the
  Dockerfile's `useradd` line.
- No SSH backend; only Docker.
- No per-channel or per-task container — one per agent for the full
  isotopes process lifetime.
