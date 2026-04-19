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

In `~/.isotopes/isotopes.yaml`:

```yaml
sandbox:
  mode: all              # off | non-main | all
  workspaceAccess: rw    # rw | ro
  docker:
    image: isotopes-sandbox:latest
    network: bridge      # bridge | host | none
    cpuLimit: 1.5
    memoryLimit: 1g
    pidsLimit: 256       # 0 disables
    capDrop: ["ALL"]
    capAdd: ["DAC_OVERRIDE", "CHOWN", "FOWNER"]
    noNewPrivileges: true
```

Per-agent overrides are supported via the same shape under an agent's `sandbox`
key.

## Modes

| Mode | Behavior |
|---|---|
| `off` | All commands run on the host. Default. |
| `non-main` | Commands run in a container unless the agent is marked "main". Currently no agent is marked main, so this behaves like `all`. |
| `all` | Every command from every agent runs in a container. |

The "main agent" concept exists in the resolver (`shouldSandbox`) but no
config flag wires it through yet — every agent is treated as non-main. Add a
`main: true` field to the agent file and read it in `cli.ts` when you need
the distinction.

## What's mounted

The agent's workspace directory (`~/.isotopes/workspace-<id>/` or whatever
`agent.workspace` resolves to) is bind-mounted at `/workspace`. With
`workspaceAccess: rw` the agent can edit `SOUL.md`, `MEMORY.md`, etc., and
the changes persist to the host. With `ro` they cannot — but most agents
need `rw` to maintain their own state.

Any directories listed in the agent's `allowedWorkspaces` (granted to host
file tools like `read_file` / `edit`) are also bind-mounted into the
container, **read-only**, at the same host path. This keeps `exec cat
/some/allowed/path` and `read_file /some/allowed/path` consistent. Write
access through `exec` to those paths is intentionally not supported — use
the workspace mount or a dedicated rw-allowed directory if writes are
needed.

## Background processes

`exec` with `background: true` works in sandbox mode: the host spawns a
`docker exec -i <ctr> sh -c <cmd>` child and tracks the host-side
`ChildProcess`. `process_kill` sends SIGTERM to that child, which docker
forwards into the container (default `--sig-proxy=true`).

## Verifying

After enabling and building the image:

1. Trigger any agent → ask it to run `whoami` and `cat /etc/os-release`.
   You should see `agent` and `Debian`, not your host user / macOS.
2. Run `exec` with `background: true sleep 30`, then `process_list` (status
   running) and `docker exec <ctr> ps -ef` (sleep visible). Then
   `process_kill` and confirm status moves to `exited`.
3. Stop isotopes (Ctrl+C). `docker ps -a | grep isotopes-sandbox-` should
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
