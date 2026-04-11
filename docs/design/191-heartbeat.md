# Design: #191 Heartbeat System

## Overview

Periodic wake-up system for agents to perform proactive work. When triggered, the agent reads `HEARTBEAT.md` from workspace and decides what actions to take. Uses silent reply to avoid spamming channels when nothing to report.

## Architecture

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ HeartbeatManager│──────▶│  AgentInstance  │──────▶│  Silent Reply   │
│   (per agent)   │       │     .prompt()   │       │  (NO_REPLY)     │
└─────────────────┘       └─────────────────┘       └─────────────────┘
        │
        ▼
┌─────────────────┐
│  HEARTBEAT.md   │
│  (workspace)    │
└─────────────────┘
```

## Config

```yaml
agents:
  - id: assistant
    heartbeat:
      enabled: true
      intervalSeconds: 300    # 5 minutes (default: 300)
      # Or use cron:
      # cron: "*/5 * * * *"   # every 5 minutes
```

## Heartbeat Prompt

When heartbeat triggers, agent receives:

```
[HEARTBEAT]

The current time is {timestamp}.

Your HEARTBEAT.md file says:
---
{contents of HEARTBEAT.md}
---

Review your scheduled tasks and decide if any action is needed.
If nothing to do, respond with only: NO_REPLY
```

## Components

### HeartbeatManager (new)

```typescript
// src/automation/heartbeat.ts

interface HeartbeatConfig {
  enabled: boolean;
  intervalSeconds?: number;  // default: 300 (5 min)
  cron?: string;             // alternative: cron expression
}

interface HeartbeatManagerOptions {
  agentId: string;
  workspacePath: string;
  config: HeartbeatConfig;
  onTrigger: (agentId: string, prompt: string) => Promise<string>;
}

class HeartbeatManager {
  start(): void;
  stop(): void;
  trigger(): Promise<void>;  // manual trigger for testing
}
```

### Integration Points

1. **cli.ts**: Create HeartbeatManager per agent with heartbeat config
2. **workspace/templates.ts**: Add HEARTBEAT.md template
3. **silent-reply.ts**: Already handles NO_REPLY (merged in #227)

## HEARTBEAT.md Template

```markdown
# HEARTBEAT.md — Periodic Tasks

When I wake up on heartbeat, I should:

1. (Add your periodic tasks here)
2. ...

If nothing needs attention, reply with: NO_REPLY
```

## Execution Flow

1. Timer fires (interval or cron)
2. HeartbeatManager reads `HEARTBEAT.md` from workspace
3. Builds heartbeat prompt with timestamp and file contents
4. Calls `agentInstance.prompt(heartbeatPrompt)`
5. Collects response
6. If response is `NO_REPLY` → silent, no output
7. Otherwise → log output (future: route to channel?)

## Open Questions

- **Q1**: Where should heartbeat output go? Options:
  - (a) Logs only (v1 — simplest)
  - (b) Configurable channel per agent
  - (c) Agent decides via tool call

  **Decision**: v1 = logs only. Future: channel routing.

- **Q2**: Should heartbeat have its own session?
  - Yes — heartbeat context should be isolated from user conversations
  - Use session key like `heartbeat:{agentId}`

## Files Changed

| File | Change |
|------|--------|
| `src/automation/heartbeat.ts` | New: HeartbeatManager class |
| `src/automation/heartbeat.test.ts` | New: tests |
| `src/automation/index.ts` | Export heartbeat |
| `src/core/config.ts` | Add HeartbeatConfigFile |
| `src/cli.ts` | Wire up HeartbeatManager per agent |
| `src/workspace/templates.ts` | Add HEARTBEAT.md template |
| `isotopes.example.yaml` | Document heartbeat config |

## Acceptance Criteria

- [ ] HeartbeatManager triggers at configured interval
- [ ] Reads HEARTBEAT.md from workspace
- [ ] Agent receives heartbeat prompt with timestamp
- [ ] NO_REPLY response is silent (no logs beyond debug)
- [ ] Non-NO_REPLY response is logged
- [ ] Heartbeat isolated to its own session
- [ ] Tests cover trigger, silent reply, error handling
