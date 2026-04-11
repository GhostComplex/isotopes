# PRD: WebChat Frontend (#98)

> Version: 0.1.0
> Date: 2026-04-11
> Status: **Design**
> Assignee: Tachikoma

## Summary

A browser-based chat interface for Isotopes that enables direct agent interaction without requiring Discord/Feishu setup. Serves as:
1. **Development tool** — debug and iterate on agents without external platform dependencies
2. **Incubation surface** — spin up new agents and test them interactively
3. **Standalone interface** — lightweight alternative to full chat platforms

## Problem

Currently the only way to interact with Isotopes agents is through Discord or Feishu transports. This creates a high barrier:
- Agent must have a bot token + be added to a server
- Debugging requires round-tripping through an external platform
- No way to quickly test changes during development

## Architecture

### Approach: Embedded SPA + SSE Streaming

The WebChat will be a React SPA served directly by the existing Isotopes HTTP server (the `ApiServer` in `src/api/server.ts`). No separate dev server in production — the built frontend is served as static files from the API.

```
┌─────────────────────────────────────────────┐
│  Browser (React SPA)                        │
│  ┌───────────────────────────────────────┐  │
│  │  Chat UI                              │  │
│  │  - Message list (streaming)           │  │
│  │  - Input box                          │  │
│  │  - Agent selector                     │  │
│  │  - Session sidebar                    │  │
│  └────────────┬──────────────────────────┘  │
└───────────────┼─────────────────────────────┘
                │ HTTP + SSE
┌───────────────┼─────────────────────────────┐
│  Isotopes API Server                        │
│  ┌────────────┴──────────────────────────┐  │
│  │  New endpoints:                       │  │
│  │  POST /api/chat       → SSE stream    │  │
│  │  GET  /api/agents     → agent list    │  │
│  │  Static file serving  → SPA assets    │  │
│  └────────────┬──────────────────────────┘  │
│  ┌────────────┴──────────────────────────┐  │
│  │  WebTransport (new)                   │  │
│  │  - Reuses AgentManager, SessionStore  │  │
│  │  - Reuses runAgentLoop()              │  │
│  │  - Same session/message model         │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Why SSE over WebSocket

- Simpler — unidirectional server→client streaming is all we need for text deltas
- Uses standard HTTP — works through proxies, load balancers without upgrade negotiation
- User messages go via regular POST requests
- Matches the existing `AgentEvent` streaming model perfectly
- Can always add WebSocket later if bidirectional communication is needed

### Key Design Decisions

1. **Reuse existing infrastructure** — `AgentManager`, `SessionStore`, `runAgentLoop()` are transport-agnostic. WebChat is just another transport.
2. **Embedded, not external** — the SPA is built at `pnpm build` time and served by the same HTTP server. Zero extra processes.
3. **Session model** — each browser tab gets a session (stored in SessionStore with `transport: 'web'`). Sessions persist across page reloads via `sessionId` in URL or localStorage.
4. **No auth in v1** — the API already binds to `127.0.0.1` by default. Auth can be added later for remote access.

## Milestones

### M1: Chat API + Minimal UI (this PR)

**Backend:**
- `POST /api/chat` — accepts `{ agentId, sessionId?, message }`, returns SSE stream of `AgentEvent`s
- `GET /api/agents` — returns list of configured agents (id + name)
- Static file serving middleware for the SPA

**Frontend (React + Vite):**
- Single chat view with message list and input
- SSE streaming — tokens appear as they arrive
- Agent selector dropdown (if multiple agents configured)
- New session / session persistence via localStorage
- Responsive layout, dark/light theme

**Infrastructure:**
- `web/` directory at repo root for the SPA source
- Vite build outputs to `web/dist/`, embedded in the API server at build time
- `pnpm build` compiles both TypeScript backend and React frontend

### M2: Session Management (future)

- Session sidebar — list, switch, delete sessions
- Session history — load previous conversations
- Session naming / renaming

### M3: Enhanced UI (future)

- Markdown rendering in messages
- Code block syntax highlighting
- Tool call visualization (collapsible panels showing tool name, args, result)
- File upload / image support
- Mobile-responsive improvements

## API Design

### POST /api/chat

**Request:**
```json
{
  "agentId": "major",
  "sessionId": "optional-existing-session-id",
  "message": "Hello, how are you?"
}
```

**Response:** SSE stream (`Content-Type: text/event-stream`)

```
event: session
data: {"sessionId": "abc-123"}

event: text_delta
data: {"text": "Hello"}

event: text_delta
data: {"text": "! I'm"}

event: text_delta
data: {"text": " doing well."}

event: tool_call
data: {"id": "tc_1", "name": "read_file", "args": {"path": "README.md"}}

event: tool_result
data: {"id": "tc_1", "output": "# Isotopes\n...", "isError": false}

event: done
data: {"stopReason": "end"}

event: error
data: {"message": "Context window overflow"}
```

### GET /api/agents

**Response:**
```json
[
  { "id": "major", "name": "Major" },
  { "id": "tachikoma", "name": "Tachikoma" }
]
```

## Frontend Tech Stack

- **React 19** + **TypeScript**
- **Vite** for build/dev
- **Tailwind CSS** for styling
- No heavy component library — keep it lightweight
- `EventSource` API for SSE consumption

## File Structure

```
web/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── components/
│   │   ├── ChatView.tsx
│   │   ├── MessageList.tsx
│   │   ├── MessageInput.tsx
│   │   ├── AgentSelector.tsx
│   │   └── StreamingMessage.tsx
│   ├── hooks/
│   │   ├── useChat.ts
│   │   └── useAgents.ts
│   └── lib/
│       ├── api.ts
│       └── types.ts
└── dist/           # Build output (gitignored)
```

## Out of Scope (v1)

- Authentication / authorization
- Multi-user support
- WebSocket transport
- File upload
- Voice input/output
- Mobile app
- Admin dashboard (separate issue #100)

## Testing Strategy

- **Backend:** Unit tests for new route handlers, SSE serialization
- **Frontend:** Manual testing in v1 (automated tests in M2+)
- **Integration:** Smoke test — start daemon, open browser, send message, verify streaming response

## Dependencies

- No new backend dependencies (Node.js built-in http + existing AgentManager/SessionStore)
- Frontend: `react`, `react-dom`, `vite`, `tailwindcss`, `@types/react`
