import { useState, useEffect, useRef, useCallback } from "react";
import { randomUUID } from "node:crypto";
import * as api from "./api.js";
import { historyToChatMessages, extractResultText } from "./messages.js";
import type { ChatMessage, ContentBlock, SSEEvent } from "./types.js";

const MAX_HISTORY_MESSAGES = 20;

export interface ChatSession {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  isStreaming: boolean;
  agentReady: boolean;
  agentId: string;
  error: string | null;
  send: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  abort: () => void;
  resetOwned: () => Promise<void>;
}

export function useChatSession(opts: {
  agentId: string;
  sessionKey: string;
  mode: "owned" | "attach";
}): ChatSession {
  const { agentId: propAgentId, sessionKey, mode } = opts;
  const isAttached = mode === "attach";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [agentId, setAgentId] = useState(propAgentId);
  const [error, setError] = useState<string | null>(null);

  const sessionKeyRef = useRef<string | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const attachAbortRef = useRef<AbortController | null>(null);
  const pendingSteerRef = useRef<ChatMessage[]>([]);

  const pushSystem = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: "system", content, timestamp: new Date() }]);
  }, []);

  const init = useCallback(async () => {
    setAgentReady(false);
    setError(null);
    try {
      const running = await api.isDaemonRunning();
      if (!running) {
        setError("Daemon not running. Start with: isotopes start");
        return;
      }

      if (mode === "attach") {
        sessionKeyRef.current = sessionKey;
        const { items: history } = await api.getHistory(propAgentId, sessionKey);
        setMessages(historyToChatMessages(history));
        const attachAbort = new AbortController();
        attachAbortRef.current = attachAbort;
        void (async () => {
          try {
            await api.attachStream(propAgentId, sessionKey, (m) => {
              const converted = historyToChatMessages([m.message as { role: string; content: unknown; toolCallId?: string }]);
              if (converted.length > 0) {
                setMessages((prev) => [...prev, ...converted]);
              }
            }, attachAbort.signal);
          } catch (err) {
            if (!attachAbort.signal.aborted) {
              setError(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        })();
        setAgentReady(true);
        return;
      }

      const session = await api.createSession(propAgentId, sessionKey);
      sessionKeyRef.current = session.key;
      setAgentId(session.agentId);

      if (session.resumed) {
        const { items: history } = await api.getHistory(session.agentId, session.key);
        const chatMessages = historyToChatMessages(history).slice(-MAX_HISTORY_MESSAGES);
        if (chatMessages.length > 0) {
          const skipped = history.length - chatMessages.length;
          const prefix: ChatMessage[] = skipped > 0
            ? [{ role: "system", content: `… ${skipped} earlier messages`, timestamp: chatMessages[0].timestamp }]
            : [];
          setMessages([...prefix, ...chatMessages]);
        }
      }
      setAgentReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ChatScreen is remounted via React `key` whenever (agentId, sessionKey, mode)
  // change in App.tsx, so this effect's [] deps are correct — fresh mount each switch.
  useEffect(() => {
    void init();
    return () => {
      sendAbortRef.current?.abort();
      attachAbortRef.current?.abort();
    };
  }, []);

  const sendAttach = async (text: string) => {
    const key = sessionKeyRef.current;
    if (!key) return;
    setIsStreaming(true);
    const abort = new AbortController();
    sendAbortRef.current = abort;
    try {
      await api.sendMessage(agentId, key, text, () => {}, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        pushSystem(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      sendAbortRef.current = null;
      setIsStreaming(false);
    }
  };

  const sendOwned = async (text: string) => {
    const key = sessionKeyRef.current;
    if (!key) return;
    setMessages((prev) => [...prev, { role: "user", content: text, timestamp: new Date() }]);
    setIsStreaming(true);

    let blocks: ContentBlock[] = [];
    const abort = new AbortController();
    sendAbortRef.current = abort;
    let streamMsgId = randomUUID();
    pendingSteerRef.current = [];

    const updateAssistant = () => {
      const fullText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const msgId = streamMsgId;
      const assistantMsg: ChatMessage = { role: "assistant", content: fullText, blocks: blocks.map((b) => ({ ...b })), timestamp: new Date(), id: msgId };
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msgId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = assistantMsg;
          return updated;
        }
        return [...prev, assistantMsg];
      });
    };

    const handleEvent = (e: SSEEvent) => {
      if (e.type === "text_delta") {
        const last = blocks[blocks.length - 1];
        if (last?.type === "text") {
          blocks[blocks.length - 1] = { type: "text", text: last.text + e.text };
        } else {
          blocks.push({ type: "text", text: e.text });
        }
        updateAssistant();
      } else if (e.type === "tool_call") {
        blocks.push({ type: "tool", id: e.toolCallId, name: e.toolName, args: typeof e.args === "string" ? e.args : JSON.stringify(e.args) });
        updateAssistant();
      } else if (e.type === "tool_result") {
        const idx = blocks.findIndex((b) => b.type === "tool" && b.id === e.toolCallId);
        if (idx >= 0 && blocks[idx].type === "tool") {
          blocks[idx] = { ...(blocks[idx] as ContentBlock & { type: "tool" }), result: extractResultText(e.result), isError: e.isError };
        }
        updateAssistant();
      } else if (e.type === "turn_end") {
        if (pendingSteerRef.current.length > 0) {
          const flushed = pendingSteerRef.current.splice(0);
          setMessages((prev) => [...prev, ...flushed]);
        }
        blocks = [];
        streamMsgId = randomUUID();
      } else if (e.type === "error") {
        pushSystem(`Error: ${e.message}`);
      }
    };

    try {
      await api.sendMessage(agentId, key, text, handleEvent, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        pushSystem(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (pendingSteerRef.current.length > 0) {
        const flushed = pendingSteerRef.current.splice(0);
        setMessages((prev) => [...prev, ...flushed]);
      }
      sendAbortRef.current = null;
      setIsStreaming(false);
    }
  };

  const send = async (text: string) => {
    if (!sessionKeyRef.current || isStreaming) return;
    if (isAttached) await sendAttach(text);
    else await sendOwned(text);
  };

  const steer = async (text: string) => {
    const key = sessionKeyRef.current;
    if (!key) return;
    pendingSteerRef.current.push({ role: "user", content: text, timestamp: new Date() });
    try {
      await api.steerMessage(agentId, key, text);
    } catch (err) {
      pushSystem(`Steer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const abort = () => {
    const key = sessionKeyRef.current;
    sendAbortRef.current?.abort();
    if (key) void api.abortMessage(agentId, key).catch(() => {});
  };

  const resetOwned = async () => {
    if (isAttached) return;
    const key = sessionKeyRef.current;
    setMessages([]);
    setIsStreaming(true);
    try {
      if (key) await api.deleteSession(agentId, key).catch(() => {});
      const session = await api.createSession(agentId, sessionKey);
      sessionKeyRef.current = session.key;
      setMessages([{ role: "system", content: "New conversation started.", timestamp: new Date() }]);
    } catch (err) {
      setMessages([{ role: "system", content: `Error: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date() }]);
    } finally {
      setIsStreaming(false);
    }
  };

  return { messages, setMessages, isStreaming, agentReady, agentId, error, send, steer, abort, resetOwned };
}
