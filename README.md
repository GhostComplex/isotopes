# Isotopes

A lightweight, self-hostable AI agent framework for multi-agent collaboration across chat platforms.

## Quick Start

```bash
# Install globally from npm
npm install -g @ghostcomplex/isotopes

# Generate ~/.isotopes/isotopes.yaml (interactive: pick LLM provider + channel)
isotopes init

# Set your API key, then run
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
isotopes start [--config path]     Start as background daemon
isotopes stop                      Stop the running daemon
isotopes status                    Show daemon status
isotopes restart [--config path]   Restart the daemon

isotopes service install           Install as system service (launchd/systemd)
isotopes service uninstall         Remove system service
isotopes service enable            Enable service (auto-start on boot)
isotopes service disable           Disable service

Options:
  -h, --help       Show help
  -v, --version    Show version
  -c, --config     Path to config file
```

## Configuration

```yaml
# ~/.isotopes/isotopes.yaml

provider:
  type: anthropic                    # anthropic | openai | openai-proxy | anthropic-proxy
  model: claude-sonnet-4-20250514
  apiKey: ${ANTHROPIC_API_KEY}

tools:
  cli: false                         # Shell execution (default: off)
  fs:
    workspaceOnly: true              # Restrict file tools to workspace

agents:
  - id: assistant
    name: Assistant
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
        tokenEnv: DISCORD_TOKEN
        defaultAgentId: assistant

# See isotopes.example.yaml for full options including:
# - Agent bindings (channel + account + peer routing)
# - Feishu transport
# - Cron jobs
# - Sandbox/Docker config
```

See [isotopes.example.yaml](isotopes.example.yaml) for all options.

## License

MIT

