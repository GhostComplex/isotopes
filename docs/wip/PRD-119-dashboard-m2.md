# PRD-119: Dashboard M2

## Overview
Expand the admin dashboard with agent management, config editing, and basic authentication.

## Goals
1. **Agent Status & Control** — View running agents, start/stop them
2. **Config Editing** — Edit agent configs from dashboard
3. **Basic Auth** — Protect dashboard access

## Non-Goals
- Full RBAC / multi-user auth
- Real-time agent metrics (defer to M3)

## Current State
- Dashboard shows sessions and logs
- No agent management UI
- No config editing
- No authentication

## Design

### 1. Agent Status & Control

**API Endpoints:**
```
GET  /api/agents          — List all agents with status
POST /api/agents/:id/stop — Stop an agent
POST /api/agents/:id/start — Start an agent
```

**UI:**
- New "Agents" tab in dashboard
- Table: Agent name, status (running/stopped), PID, uptime
- Actions: Stop/Start buttons

**Implementation:**
- Read agent configs from `~/.isotopes/agents/`
- Check running processes via PID files or process list
- Use `spawn` to start agents, signals to stop

### 2. Config Editing

**API Endpoints:**
```
GET  /api/agents/:id/config — Get agent config
PUT  /api/agents/:id/config — Update agent config
```

**UI:**
- Click agent row → expand config editor
- JSON editor with validation
- Save button → PUT to API

**Safety:**
- Validate JSON before save
- Backup current config before overwrite
- Require restart for config changes to take effect

### 3. Basic Auth

**Implementation:**
- Simple username/password in environment or config
- Session cookie after login
- Middleware to protect all `/api/*` routes

**UI:**
- Login page at `/login`
- Redirect to login if not authenticated
- Logout button in header

**Config:**
```yaml
dashboard:
  auth:
    username: admin
    password: ${DASHBOARD_PASSWORD}
```

## Phases

### Phase 1 (this PR)
- [ ] Agent list API + UI
- [ ] Agent start/stop API + UI
- [ ] Basic auth (env-based password)

### Phase 2 (follow-up)
- [ ] Config editing UI
- [ ] Config validation
- [ ] Config backup

## Files to Modify
- `packages/pi-agent-core/src/dashboard/routes.ts` — new API endpoints
- `packages/pi-agent-core/src/dashboard/public/app.js` — new UI tabs
- `packages/pi-agent-core/src/dashboard/public/styles.css` — styling
- `packages/pi-agent-core/src/dashboard/auth.ts` — new auth middleware

## Testing
- Unit tests for auth middleware
- Integration tests for agent API endpoints
- Manual test: login → view agents → stop/start

## Risks
- Starting/stopping agents could disrupt active sessions
- Config editing could break agents if validation is insufficient

## Open Questions
1. Should we require password change on first login?
2. Should config changes auto-restart the agent?
