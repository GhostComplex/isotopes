# Dashboard M1 PRD — Read-Only Admin Panel

## Overview
Minimal admin dashboard for Isotopes. Read-only in M1, no config editing.

## Goals
- Status overview (uptime, session count, cron jobs)
- Session list + transcript viewing
- Cron job list
- Log viewer (real-time tail)

## Non-Goals (M2+)
- Config editing
- Workspace file editing
- CRUD operations

## Technical Spec

### API Changes
1. **New endpoint: `GET /api/logs?lines=N`**
   - Returns last N lines of log file (default 100)
   - Use `tail` command, NOT `readFileSync` (avoid OOM on large files)
   - Check multiple log paths: `isotopes.log`, `isotopes.out.log`

2. **Integrate ApiServer into cli.ts**
   - Start API server on port 2712
   - Add graceful shutdown on SIGINT/SIGTERM

### Frontend
- Location: `web/dashboard/`
- Stack: Vanilla HTML/JS/CSS (no build step)
- Static file serving via `src/api/static.ts`
- Dark theme, responsive layout

### Pages
1. **Status** (`/dashboard`) — uptime, session count, cron count
2. **Sessions** (`/dashboard#/sessions`) — list + transcript detail
3. **Cron** (`/dashboard#/cron`) — cron job list with schedule info
4. **Logs** (`/dashboard#/logs`) — real-time log tail (2s polling)

### Files to Create/Modify
- `web/dashboard/index.html` — SPA shell
- `web/dashboard/app.js` — routing, API calls, rendering
- `web/dashboard/styles.css` — dark theme styles
- `src/api/static.ts` — static file server middleware
- `src/api/routes.ts` — add `/api/logs` endpoint
- `src/cli.ts` — instantiate and start ApiServer

## Success Criteria
- `http://127.0.0.1:2712/dashboard` loads
- All 4 pages render correctly with live data
- Logs refresh every 2 seconds
- `tsc` passes
- Clean commit history
