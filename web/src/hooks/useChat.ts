import { useCallback, useRef, useState } from "react";
import type { Message, ToolCall } from "../lib/types";
import { fetchSessionHistory, streamChat } from "../lib/api";

const SESSION_KEY = "isotopes-webchat-session";

function loadStoredSession(): { agentId: string; sessionId: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storeSession(agentId: string, sessionId: string) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ agentId, sessionId }));
}

function clearStoredSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function useChat(agentId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Load session history on agent change
  const loadHistory = useCallback(async () => {
    setHistoryLoaded(false);
    setMessages([]);
    sessionIdRef.current = null;

    const stored = loadStoredSession();
    if (stored && stored.agentId === agentId) {
      try {
        const data = await fetchSessionHistory(stored.sessionId);
        sessionIdRef.current = stored.sessionId;
        setMessages(
          data.history
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              timestamp: m.timestamp,
            })),
        );
      } catch {
        clearStoredSession();
      }
    }
    setHistoryLoaded(true);
  }, [agentId]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || streaming) return;

      const userMessage: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
      setStreaming(true);

      const assistantMessage: Message = {
        role: "assistant",
        content: "",
        toolCalls: [],
      };

      const abort = new AbortController();
      abortRef.current = abort;

      // Track tool calls by id for matching results
      const pendingTools = new Map<string, ToolCall>();

      streamChat(
        agentId,
        text,
        sessionIdRef.current,
        (event) => {
          switch (event.type) {
            case "session":
              sessionIdRef.current = event.sessionId;
              storeSession(agentId, event.sessionId);
              break;
            case "text_delta":
              assistantMessage.content += event.text;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [...prev.slice(0, -1), { ...assistantMessage }];
                }
                return [...prev, { ...assistantMessage }];
              });
              break;
            case "tool_call": {
              const tc: ToolCall = {
                id: event.id,
                name: event.name,
                args: event.args,
              };
              pendingTools.set(event.id, tc);
              assistantMessage.toolCalls = [
                ...(assistantMessage.toolCalls ?? []),
                tc,
              ];
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [...prev.slice(0, -1), { ...assistantMessage }];
                }
                return [...prev, { ...assistantMessage }];
              });
              break;
            }
            case "tool_result": {
              const tc = pendingTools.get(event.id);
              if (tc) {
                tc.output = event.output;
                tc.isError = event.isError;
                assistantMessage.toolCalls = [
                  ...(assistantMessage.toolCalls ?? []),
                ].map((t) => (t.id === event.id ? { ...tc } : t));
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant") {
                    return [...prev.slice(0, -1), { ...assistantMessage }];
                  }
                  return [...prev, { ...assistantMessage }];
                });
              }
              break;
            }
            case "done":
              setStreaming(false);
              break;
            case "error":
              assistantMessage.content +=
                (assistantMessage.content ? "\n\n" : "") +
                `**Error:** ${event.error}`;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [...prev.slice(0, -1), { ...assistantMessage }];
                }
                return [...prev, { ...assistantMessage }];
              });
              setStreaming(false);
              break;
          }
        },
        abort.signal,
      );
    },
    [agentId, streaming],
  );

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    sessionIdRef.current = null;
    clearStoredSession();
    setMessages([]);
    setStreaming(false);
  }, []);

  return { messages, streaming, sendMessage, newChat, loadHistory, historyLoaded };
}
