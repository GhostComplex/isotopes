import { useState, useEffect, useRef, useCallback } from "react";
import { randomUUID } from "node:crypto";
import type { TuiMessage, ContentItem } from "./types.js";
import type { SessionEvent } from "../gateway/types.js";
import { historyToTuiMessages, tuiMessage } from "./messages.js";
import * as api from "./api.js";

const MAX_VISIBLE_MESSAGES = 50;

export interface UseSessionResult {
  messages: TuiMessage[];
  settled: TuiMessage[];
  dynamic: TuiMessage[];
  isStreaming: boolean;
  agentReady: boolean;
  effectiveAgentId: string;
  error: string | null;
  pushMessage: (msg: TuiMessage) => void;
  sendMessage: (text: string) => void;
  abortStream: () => void;
}

export function useSession(
  agentId: string,
  sessionKey: string,
): UseSessionResult {
  const [messages, setMessages] = useState<TuiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [effectiveAgentId, setEffectiveAgentId] = useState(agentId);
  const [error, setError] = useState<string | null>(null);

  const contentRef = useRef<ContentItem[]>([]);
  const streamMsgIdRef = useRef(randomUUID());
  const settledRef = useRef<TuiMessage[]>([]);
  const sessionKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resetMessages = useCallback((initial?: TuiMessage[]) => {
    setMessages(initial ?? []);
    settledRef.current = [];
    contentRef.current = [];
    streamMsgIdRef.current = randomUUID();
  }, []);

  const pushMessage = useCallback((msg: TuiMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const flushContent = useCallback(() => {
    const items = contentRef.current;
    const msgId = streamMsgIdRef.current;
    const msg = tuiMessage("assistant", [...items], new Date(), msgId);
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

  const connectStream = useCallback((aid: string, skey: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void api.subscribe(aid, skey, handleEvent, ctrl.signal).catch((err) => {
      if (!ctrl.signal.aborted) setError(`Subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [handleEvent]);

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

        const session = await api.createSession(agentId, sessionKey);
        if (cancelled) return;
        const aid = session.agentId;
        const skey = session.key;
        setEffectiveAgentId(session.agentId);

        if (session.resumed) {
          const { items } = await api.getMessages(aid, skey);
          if (cancelled) return;
          resetMessages(historyToTuiMessages(items));
        }

        sessionKeyRef.current = skey;
        connectStream(aid, skey);
        setAgentReady(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; abortRef.current?.abort(); };
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!sessionKeyRef.current) return;
    pushMessage(tuiMessage("user", text));
    void api.dispatch(effectiveAgentId, sessionKeyRef.current, text).catch((err) => {
      pushMessage(tuiMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`));
    });
  }, [effectiveAgentId, pushMessage]);

  const abortStream = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    if (sessionKeyRef.current) void api.abortSession(effectiveAgentId, sessionKeyRef.current).catch(() => {});
  }, [effectiveAgentId]);

  // Settled/dynamic split: freeze settled count while streaming so the
  // in-progress assistant message stays in the dynamic (re-renderable) section.
  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);
  const settledCount = isStreaming ? settledRef.current.length : visible.length;
  if (settledCount > settledRef.current.length) {
    settledRef.current = visible.slice(0, settledCount);
  }
  const dynamic = visible.slice(settledRef.current.length);

  return {
    messages,
    settled: settledRef.current,
    dynamic,
    isStreaming,
    agentReady,
    effectiveAgentId,
    error,
    pushMessage,
    sendMessage,
    abortStream,
  };
}
