import { useState, useEffect, useRef, useCallback } from "react";
import { randomUUID } from "node:crypto";
import type { TuiMessage, ContentItem } from "./types.js";
import type { SessionEvent } from "../gateway/types.js";
import { historyToTuiMessages, tuiMessage } from "./messages.js";
import * as api from "./api.js";

const MAX_VISIBLE_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 20;

// ---------------------------------------------------------------------------
// useStream — SSE event handling + content accumulation + settled/dynamic split
// ---------------------------------------------------------------------------

export interface UseStreamResult {
  messages: TuiMessage[];
  settled: TuiMessage[];
  dynamic: TuiMessage[];
  isStreaming: boolean;
  handleEvent: (e: SessionEvent) => void;
  pushMessage: (msg: TuiMessage) => void;
  resetMessages: (initial?: TuiMessage[]) => void;
}

export function useStream(): UseStreamResult {
  const [messages, setMessages] = useState<TuiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const contentRef = useRef<ContentItem[]>([]);
  const streamMsgIdRef = useRef(randomUUID());
  const settledRef = useRef<TuiMessage[]>([]);

  const flushContent = useCallback(() => {
    const items = contentRef.current;
    const msgId = streamMsgIdRef.current;
    const msg: TuiMessage = { role: "assistant", content: [...items], timestamp: new Date(), id: msgId };
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msgId);
      if (idx >= 0) { const next = [...prev]; next[idx] = msg; return next; }
      return [...prev, msg];
    });
  }, []);

  const handleEvent = useCallback((e: SessionEvent) => {
    if (e.type === "text_delta") {
      setIsStreaming(true);
      const items = contentRef.current;
      const last = items[items.length - 1];
      if (last?.type === "text") {
        (last as { text: string }).text += e.delta;
      } else {
        items.push({ type: "text", text: e.delta });
      }
      flushContent();
    } else if (e.type === "tool_call") {
      contentRef.current.push({
        type: "tool",
        id: e.toolCallId,
        name: e.toolName,
        args: typeof e.args === "string" ? e.args : JSON.stringify(e.args),
      });
      flushContent();
    } else if (e.type === "tool_result") {
      const tc = contentRef.current.find((b): b is ContentItem & { type: "tool" } => b.type === "tool" && b.id === e.toolCallId);
      if (tc) { tc.completed = true; tc.isError = e.isError; }
      flushContent();
    } else if (e.type === "turn_end") {
      contentRef.current = [];
      streamMsgIdRef.current = randomUUID();
    } else if (e.type === "agent_end") {
      contentRef.current = [];
      setIsStreaming(false);
      if (e.stopReason === "error" && e.errorMessage) {
        setMessages((prev) => [...prev, tuiMessage("system", `Error: ${e.errorMessage}`)]);
      }
    }
  }, [flushContent]);

  const pushMessage = useCallback((msg: TuiMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const resetMessages = useCallback((initial?: TuiMessage[]) => {
    setMessages(initial ?? []);
    settledRef.current = [];
    contentRef.current = [];
    streamMsgIdRef.current = randomUUID();
  }, []);

  // Settled/dynamic split: freeze settled count while streaming so the
  // in-progress assistant message stays in the dynamic (re-renderable) section.
  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);
  const settledCount = isStreaming ? settledRef.current.length : visible.length;
  if (settledCount > settledRef.current.length) {
    settledRef.current = visible.slice(0, settledCount);
  }
  const dynamic = visible.slice(settledRef.current.length);

  return { messages, settled: settledRef.current, dynamic, isStreaming, handleEvent, pushMessage, resetMessages };
}

// ---------------------------------------------------------------------------
// useChat — session management + message dispatch + stream lifecycle
// ---------------------------------------------------------------------------

export interface UseChatResult {
  messages: TuiMessage[];
  settled: TuiMessage[];
  dynamic: TuiMessage[];
  isStreaming: boolean;
  agentReady: boolean;
  effectiveAgentId: string;
  error: string | null;
  pushMessage: (msg: TuiMessage) => void;
  sendMessage: (text: string) => void;
  startNewChat: () => void;
  abortStream: () => void;
}

export function useChat(
  agentId: string,
  sessionKey: string,
  mode: "owned" | "attach",
): UseChatResult {
  const stream = useStream();
  const [agentReady, setAgentReady] = useState(false);
  const [effectiveAgentId, setEffectiveAgentId] = useState(agentId);
  const [error, setError] = useState<string | null>(null);

  const sessionKeyRef = useRef<string | null>(null);
  const attachAbortRef = useRef<AbortController | null>(null);

  const connectStream = useCallback((aid: string, skey: string) => {
    attachAbortRef.current?.abort();
    const ctrl = new AbortController();
    attachAbortRef.current = ctrl;
    void api.attachStream(aid, skey, stream.handleEvent, ctrl.signal).catch((err) => {
      if (!ctrl.signal.aborted) setError(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [stream.handleEvent]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAgentReady(false);
      setError(null);
      try {
        if (!(await api.isDaemonRunning())) {
          setError("Daemon not running. Start with: isotopes start");
          return;
        }

        let aid = agentId;
        let skey = sessionKey;
        if (mode === "owned") {
          const session = await api.createSession(agentId, sessionKey);
          if (cancelled) return;
          aid = session.agentId;
          skey = session.key;
          setEffectiveAgentId(session.agentId);
          if (session.resumed) {
            const { items } = await api.getMessages(aid, skey);
            if (cancelled) return;
            const msgs = historyToTuiMessages(items).slice(-MAX_HISTORY_MESSAGES);
            if (msgs.length > 0) {
              const skipped = items.length - msgs.length;
              const prefix: TuiMessage[] = skipped > 0
                ? [tuiMessage("system", `… ${skipped} earlier messages`, msgs[0].timestamp)]
                : [];
              stream.resetMessages([...prefix, ...msgs]);
            }
          }
        } else {
          const { items } = await api.getMessages(agentId, sessionKey);
          if (cancelled) return;
          stream.resetMessages(historyToTuiMessages(items));
        }
        sessionKeyRef.current = skey;
        connectStream(aid, skey);
        setAgentReady(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; attachAbortRef.current?.abort(); };
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!sessionKeyRef.current) return;
    stream.pushMessage(tuiMessage("user", text));
    void api.dispatch(effectiveAgentId, sessionKeyRef.current, text).catch((err) => {
      stream.pushMessage(tuiMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`));
    });
  }, [effectiveAgentId, stream.pushMessage]);

  const startNewChat = useCallback(() => {
    if (mode === "attach") {
      stream.pushMessage(tuiMessage("system", "/new is disabled while attached. Use /sessions to switch."));
      return;
    }
    stream.resetMessages();
    (async () => {
      try {
        if (sessionKeyRef.current) await api.deleteSession(effectiveAgentId, sessionKeyRef.current).catch(() => {});
        const session = await api.createSession(effectiveAgentId, sessionKey);
        sessionKeyRef.current = session.key;
        stream.resetMessages([tuiMessage("system", "New conversation started.")]);
        connectStream(session.agentId, session.key);
      } catch (err) {
        stream.resetMessages([tuiMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`)]);
      }
    })();
  }, [effectiveAgentId, sessionKey, mode, stream.pushMessage, stream.resetMessages, connectStream]);

  const abortStream = useCallback(() => {
    if (sessionKeyRef.current) void api.abortSession(effectiveAgentId, sessionKeyRef.current).catch(() => {});
  }, [effectiveAgentId]);

  return {
    messages: stream.messages,
    settled: stream.settled,
    dynamic: stream.dynamic,
    isStreaming: stream.isStreaming,
    agentReady,
    effectiveAgentId,
    error,
    pushMessage: stream.pushMessage,
    sendMessage,
    startNewChat,
    abortStream,
  };
}
