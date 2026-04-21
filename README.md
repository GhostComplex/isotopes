# Isotopes

A lightweight, self-hostable AI agent framework for multi-agent collaboration across chat platforms.

## Quick Start

```bash
# Install globally from npm
npm install -g @ghostcomplex/isotopes

# Generate ~/.isotopes/isotopes.yaml (interactive: pick LLM provider + channel)
isotopes init

# Run
export ANTHROPIC_API_KEY=sk-ant-...
isotopes

# Or run as daemon
isotopes start
isotopes status
isotopes stop
```

### From source

```bash
git clone https://github.com/GhostComplex/isotopes.git
cd isotopes
pnpm install
pnpm build

node dist/cli.js init
node dist/cli.js
```

## CLI

```
isotopes                           Run in foreground (default)
isotopes init [--force]            Generate ~/.isotopes/isotopes.yaml (interactive)
isotopes start [--config path]     Start as background daemon
isotopes stop                      Stop the running daemon
isotopes status                    Show daemon status
isotopes restart [--config path]   Restart the daemon
isotopes reload [agentId]          Reload workspace (hot-reload)

isotopes tui [--agent id] [--message "text"]
                                   Interactive TUI chat with an agent

isotopes sessions list             List all sessions
isotopes sessions show <id>        Show session details
isotopes sessions delete <id>      Delete a session
isotopes sessions reset <id>       Reset session history

isotopes cron list                 List scheduled jobs
isotopes cron add <spec> <task>    Add a cron job
isotopes cron remove <id>          Remove a cron job
isotopes cron enable/disable <id>  Enable or disable a job
isotopes cron run <id>             Run a job now

isotopes logs [--lines N] [--level LEVEL] [-f]
                                   View daemon logs

isotopes service install           Install as system service (launchd/systemd)
isotopes service uninstall         Remove system service
isotopes service enable/disable    Enable or disable auto-start on boot

Options:
  -h, --help       Show help
  -v, --version    Show version
  -c, --config     Path to config file
  --agent          Agent ID for tui command
  --message        Send an initial message in TUI mode
  --json           Output as JSON (sessions, cron commands)
  --lines          Number of log lines (default: 50)
  --level          Filter logs by level (debug/info/warn/error)
  -f, --follow     Follow log output
```

## Configuration

```yaml
# ~/.isotopes/isotopes.yaml

provider:
  type: anthropic                    # anthropic | openai | openai-proxy | anthropic-proxy
  model: claude-opus-4.6
  apiKey: ${ANTHROPIC_API_KEY}

tools:
  cli: false                         # Shell execution (default: off)
  fs:
    workspaceOnly: true              # Restrict file tools to workspace

agents:
  - id: main
    # tools:                         # Per-agent tool overrides
    #   cli: true
    # compaction:
    #   mode: safeguard              # off | safeguard | aggressive
    # sandbox:
    #   mode: non-main              # off | non-main | all

channels:
  discord:
    accounts:
      main:
        token: ${DISCORD_TOKEN}
        defaultAgentId: main
        dmAccess:
          policy: disabled           # disabled (default) | allowlist
          # allowlist:
          #   - "123456789012345678"
        groupAccess:
          policy: allowlist          # disabled | allowlist (default) | open
          # guildAllowlist:
          #   - "guild-id"
          # channelAllowlist:
          #   - "channel-id"

# See isotopes.example.yaml for full options including:
# - Agent bindings (channel + account + peer routing)
# - Feishu transport
# - Cron jobs
# - Sandbox/Docker config
```

See [isotopes.example.yaml](isotopes.example.yaml) for all options.

## License

MIT
