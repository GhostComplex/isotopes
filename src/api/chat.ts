// src/api/chat.ts — WebChat API routes
// POST /api/chat/message — synchronous chat
// POST /api/chat/stream  — SSE streaming chat

import type { ServerResponse } from "node:http";
import { addRoute } from "./routes.js";
import { sendJson, sendError } from "./middleware.js";
import { createLogger } from "../core/logger.js";
import { textContent } from "../core/types.js";

const log = createLogger("api:chat");

// ---------------------------------------------------------------------------
// POST /api/chat/message — send message, get full reply
// ---------------------------------------------------------------------------

addRoute("POST", "/api/chat/message", async (req, res, deps) => {
  const { agentManager, chatSessionStore } = deps;
  if (!agentManager || !chatSessionStore) {
    sendError(res, 501, "Chat is not configured");
    return;
  }

  const body = req.body as { agentId?: string; message?: string; sessionId?: string } | undefined;
  if (!body || typeof body.agentId !== "string" || !body.agentId) {
    sendError(res, 400, "Request body must include 'agentId' (string)");
    return;
  }
  if (typeof body.message !== "string" || !body.message) {
    sendError(res, 400, "Request body must include 'message' (string)");
    return;
  }

  const agent = agentManager.get(body.agentId);
  if (!agent) {
    sendError(res, 404, `Agent "${body.agentId}" not found`);
    return;
  }

  // Get or create session
  let sessionId = body.sessionId;
  if (sessionId) {
    const existing = await chatSessionStore.get(sessionId);
    if (!existing) {
      sessionId = undefined; // will create new
    }
  }
  if (!sessionId) {
    const session = await chatSessionStore.create(body.agentId, {
      transport: "web",
    });
    sessionId = session.id;
  }

  // Add user message to session
  await chatSessionStore.addMessage(sessionId, {
    role: "user",
    content: textContent(body.message),
    timestamp: Date.now(),
  });

  // Get conversation history and prompt agent
  const messages = await chatSessionStore.getMessages(sessionId);
  let responseText = "";
  let errorMessage: string | null = null;

  try {
    for await (const event of agent.prompt(messages)) {
      if (event.type === "text_delta") {
        responseText += event.text;
      } else if (event.type === "agent_end") {
        if (event.stopReason === "error") {
          errorMessage = event.errorMessage ?? "Unknown agent error";
          log.error(`Agent ended with error: ${errorMessage}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent error";
    log.error("Chat agent error:", err);
    sendError(res, 500, msg);
    return;
  }

  // Store assistant reply
  if (responseText) {
    await chatSessionStore.addMessage(sessionId, {
      role: "assistant",
      content: textContent(responseText),
      timestamp: Date.now(),
    });
  }

  if (errorMessage) {
    sendJson(res, 200, { sessionId, reply: responseText || null, error: errorMessage });
    return;
  }

  sendJson(res, 200, { sessionId, reply: responseText });
});

// ---------------------------------------------------------------------------
// POST /api/chat/stream — SSE streaming chat
// ---------------------------------------------------------------------------

addRoute("POST", "/api/chat/stream", async (req, res, deps) => {
  const { agentManager, chatSessionStore } = deps;
  if (!agentManager || !chatSessionStore) {
    sendError(res, 501, "Chat is not configured");
    return;
  }

  const body = req.body as { agentId?: string; message?: string; sessionId?: string } | undefined;
  if (!body || typeof body.agentId !== "string" || !body.agentId) {
    sendError(res, 400, "Request body must include 'agentId' (string)");
    return;
  }
  if (typeof body.message !== "string" || !body.message) {
    sendError(res, 400, "Request body must include 'message' (string)");
    return;
  }

  const agent = agentManager.get(body.agentId);
  if (!agent) {
    sendError(res, 404, `Agent "${body.agentId}" not found`);
    return;
  }

  // Get or create session
  let sessionId = body.sessionId;
  if (sessionId) {
    const existing = await chatSessionStore.get(sessionId);
    if (!existing) {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const session = await chatSessionStore.create(body.agentId, {
      transport: "web",
    });
    sessionId = session.id;
  }

  // Add user message
  await chatSessionStore.addMessage(sessionId, {
    role: "user",
    content: textContent(body.message),
    timestamp: Date.now(),
  });

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Session-Id": sessionId,
  });

  // Send sessionId as the first event
  writeSseEvent(res, JSON.stringify({ sessionId }));

  const messages = await chatSessionStore.getMessages(sessionId);
  let responseText = "";

  try {
    for await (const event of agent.prompt(messages)) {
      if (event.type === "text_delta") {
        responseText += event.text;
        writeSseEvent(res, JSON.stringify({ text: event.text }));
      } else if (event.type === "agent_end") {
        if (event.stopReason === "error") {
          const msg = event.errorMessage ?? "Unknown agent error";
          log.error(`Agent ended with error: ${msg}`);
          writeSseEvent(res, JSON.stringify({ error: msg }));
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent error";
    log.error("Chat stream error:", err);
    writeSseEvent(res, JSON.stringify({ error: msg }));
  }

  // Store assistant reply
  if (responseText) {
    await chatSessionStore.addMessage(sessionId, {
      role: "assistant",
      content: textContent(responseText),
      timestamp: Date.now(),
    });
  }

  // Signal stream end
  res.write("data: [DONE]\n\n");
  res.end();
});

// ---------------------------------------------------------------------------
// GET /api/chat/history — get session history
// ---------------------------------------------------------------------------

addRoute("GET", "/api/chat/history", async (req, res, deps) => {
  const { chatSessionStore } = deps;
  if (!chatSessionStore) {
    sendError(res, 501, "Chat is not configured");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    sendError(res, 400, "Query parameter 'sessionId' is required");
    return;
  }

  const session = await chatSessionStore.get(sessionId);
  if (!session) {
    sendError(res, 404, `Session "${sessionId}" not found`);
    return;
  }

  const messages = await chatSessionStore.getMessages(sessionId);

  sendJson(res, 200, {
    sessionId,
    agentId: session.agentId,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content.map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_result") return b.output;
        return "";
      }).join(""),
      timestamp: m.timestamp,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/chat/agents — list available agents
// ---------------------------------------------------------------------------

addRoute("GET", "/api/chat/agents", (_req, res, deps) => {
  const { agentManager } = deps;
  if (!agentManager) {
    sendError(res, 501, "Chat is not configured");
    return;
  }

  const agents = agentManager.list();
  sendJson(res, 200, agents.map((a) => ({
    id: a.id,
  })));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeSseEvent(res: ServerResponse, data: string): void {
  res.write(`data: ${data}\n\n`);
}
