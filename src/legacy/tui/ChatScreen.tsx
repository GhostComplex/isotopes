import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { randomUUID } from "node:crypto";
import { parseSlashCommand, dispatch, HELP_TEXT } from "./commands.js";
import type { ChatMessage, ContentBlock, Screen, StreamEvent } from "./types.js";
import { extractResultText, historyToChatMessages } from "./messages.js";
import * as api from "./api.js";

const MAX_VISIBLE_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 20;

interface Props {
  agentId: string;
  sessionKey: string;
  mode: "owned" | "attach";
  onSwitchScreen: (screen: Screen) => void;
}

export function ChatScreen({ agentId: propAgentId, sessionKey, mode, onSwitchScreen }: Props) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [agentId, setAgentId] = useState(propAgentId);
  const [error, setError] = useState<string | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const attachAbortRef = useRef<AbortController | null>(null);
  const settledRef = useRef<ChatMessage[]>([]);
  const isAttached = mode === "attach";

  const blocksRef = useRef<ContentBlock[]>([]);
  const streamMsgIdRef = useRef<string>(randomUUID());

  const renderAssistantFromBlocks = useCallback(() => {
    const blocks = blocksRef.current;
    const fullText = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const msgId = streamMsgIdRef.current;
    const assistantMsg: ChatMessage = { role: "assistant", content: fullText, blocks: [...blocks], timestamp: new Date(), id: msgId };
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msgId);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = assistantMsg;
        return updated;
      }
      return [...prev, assistantMsg];
    });
  }, []);

  const handleStreamEvent = useCallback((e: StreamEvent) => {
    if (e.type === "text_delta") {
      setIsStreaming(true);
      const blocks = blocksRef.current;
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === "text") {
        (lastBlock as { text: string }).text += e.delta;
      } else {
        blocks.push({ type: "text", text: e.delta });
      }
      renderAssistantFromBlocks();
    } else if (e.type === "tool_call") {
      blocksRef.current.push({
        type: "tool",
        id: e.toolCallId,
        name: e.toolName,
        args: typeof e.args === "string" ? e.args : JSON.stringify(e.args),
      });
      renderAssistantFromBlocks();
    } else if (e.type === "tool_result") {
      const tc = blocksRef.current.find((b): b is ContentBlock & { type: "tool" } => b.type === "tool" && b.id === e.toolCallId);
      if (tc) {
        tc.result = extractResultText(e.result);
        tc.isError = e.isError;
      }
      renderAssistantFromBlocks();
    } else if (e.type === "turn_end") {
      blocksRef.current = [];
      streamMsgIdRef.current = randomUUID();
    } else if (e.type === "agent_end") {
      blocksRef.current = [];
      setIsStreaming(false);
      if (e.stopReason === "error" && e.errorMessage) {
        setMessages((prev) => [...prev, { role: "system", content: `Error: ${e.errorMessage}`, timestamp: new Date() }]);
      }
    }
  }, [renderAssistantFromBlocks]);

  const initAgent = useCallback(async () => {
    setAgentReady(false);
    setError(null);
    try {
      const running = await api.isDaemonRunning();
      if (!running) {
        setError("Daemon not running. Start with: isotopes start");
        return;
      }

      let effectiveAgentId = propAgentId;
      let effectiveSessionKey = sessionKey;
      if (mode === "owned") {
        const session = await api.createSession(propAgentId, sessionKey);
        effectiveAgentId = session.agentId;
        effectiveSessionKey = session.key;
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
      } else {
        const { items: history } = await api.getHistory(propAgentId, sessionKey);
        setMessages(historyToChatMessages(history));
      }
      sessionKeyRef.current = effectiveSessionKey;

      const attachAbort = new AbortController();
      attachAbortRef.current = attachAbort;
      void (async () => {
        try {
          await api.attachStream(effectiveAgentId, effectiveSessionKey, handleStreamEvent, attachAbort.signal);
        } catch (err) {
          if (!attachAbort.signal.aborted) {
            setError(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })();

      setAgentReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [propAgentId, sessionKey, mode, handleStreamEvent]);

  useEffect(() => {
    void initAgent();
    return () => {
      abortRef.current?.abort();
      attachAbortRef.current?.abort();
    };
  }, []);

  const sendMessage = async (text: string) => {
    if (!sessionKeyRef.current) return;

    // Optimistic user-message render — keeps the UI snappy ahead of the
    // user_message event arriving via the stream.
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      await api.dispatch(agentId, sessionKeyRef.current, text);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "system", content: `Error: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date() }]);
    }
  };

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    const slash = parseSlashCommand(text);
    if (slash) {
      const handled = dispatch(slash.command, slash.args, {
        onNewChat: () => {
          if (isAttached) {
            setMessages((prev) => [...prev, { role: "system", content: "/new is disabled while attached to another session. Use /sessions to switch.", timestamp: new Date() }]);
            return;
          }
          setMessages([]);
          settledRef.current = [];
          attachAbortRef.current?.abort();
          setIsStreaming(true);
          (async () => {
            try {
              if (sessionKeyRef.current) {
                await api.deleteSession(agentId, sessionKeyRef.current).catch(() => {});
              }
              const session = await api.createSession(agentId, sessionKey);
              sessionKeyRef.current = session.key;
              setMessages([{ role: "system", content: "New conversation started.", timestamp: new Date() }]);
              const attachAbort = new AbortController();
              attachAbortRef.current = attachAbort;
              void api.attachStream(session.agentId, session.key, handleStreamEvent, attachAbort.signal).catch(() => {});
            } catch (err) {
              setMessages([{ role: "system", content: `Error: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date() }]);
            } finally {
              setIsStreaming(false);
            }
          })();
        },
        onExit: () => exit(),
        onShowStatus: () => onSwitchScreen("status"),
        onShowSessions: () => onSwitchScreen("sessions"),
        onHelp: () => setMessages((prev) => [...prev, { role: "system", content: HELP_TEXT, timestamp: new Date() }]),
      });
      if (!handled) {
        setMessages((prev) => [...prev, { role: "system", content: `Unknown command: /${slash.command}`, timestamp: new Date() }]);
      }
      return;
    }
    void sendMessage(text);
  };

  useInput((ch, key) => {
    if (key.return) {
      handleSubmit();
    } else if (key.escape && isStreaming) {
      abortRef.current?.abort();
      void api.abortMessage(agentId, sessionKeyRef.current!).catch(() => {});
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (key.ctrl && ch === "c") {
      if (isStreaming) {
        abortRef.current?.abort();
        void api.abortMessage(agentId, sessionKeyRef.current!).catch(() => {});
      } else {
        exit();
      }
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  const contentWidth = (process.stdout.columns || 80) - 2;

  const renderMessage = (msg: ChatMessage, i: number) => {
    const roleLabel = msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System";
    const roleColor = msg.role === "user" ? "green" : msg.role === "assistant" ? "blue" : "gray";

    if (!msg.blocks) {
      return (
        <Box key={msg.id ?? i} flexDirection="column" width={contentWidth} marginTop={i > 0 ? 1 : 0}>
          <Text wrap="wrap">
            <Text color={roleColor} bold>{roleLabel}</Text>
            <Text>: {msg.content}</Text>
          </Text>
        </Box>
      );
    }

    const elements: React.ReactNode[] = [];
    let labelRendered = false;
    for (let j = 0; j < msg.blocks.length; j++) {
      const block = msg.blocks[j];
      if (block.type === "text") {
        if (!labelRendered) {
          labelRendered = true;
          elements.push(
            <Box key={j}>
              <Text wrap="wrap">
                <Text color={roleColor} bold>{roleLabel}</Text>
                <Text>: {block.text}</Text>
              </Text>
            </Box>
          );
        } else {
          elements.push(<Box key={j}><Text wrap="wrap">{block.text}</Text></Box>);
        }
      } else {
        if (!labelRendered) {
          labelRendered = true;
          elements.push(
            <Box key={`label`}>
              <Text color={roleColor} bold>{roleLabel}</Text>
              <Text>:</Text>
            </Box>
          );
        }
        elements.push(
          <Box key={j}>
            <Text color="gray" dimColor wrap="truncate-end">
              {"  "}{block.name}({block.args.length > 60 ? block.args.slice(0, 60) + "…" : block.args}){block.isError ? " ✗" : block.result ? " ✓" : " …"}
            </Text>
          </Box>
        );
      }
    }

    return <Box key={msg.id ?? i} flexDirection="column" width={contentWidth} marginTop={i > 0 ? 1 : 0}>{elements}</Box>;
  };

  // Freeze settled count while streaming — Static is write-once, so an in-progress
  // assistant message pushed there would stop visually updating.
  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);
  const settledCount = isStreaming ? settledRef.current.length : visible.length;
  if (settledCount > settledRef.current.length) {
    const newSettled = visible.slice(settledRef.current.length, settledCount);
    settledRef.current = [...settledRef.current, ...newSettled];
  }
  const dynamicMessages = visible.slice(settledCount);

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} flexShrink={0} flexGrow={0}>
        <Text bold>isotopes</Text>
        <Text> — agent: </Text>
        <Text color="cyan">{agentId || "loading..."}</Text>
        {isAttached && <Text color="magenta"> [attached: {sessionKey}]</Text>}
        {isStreaming && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      <Static items={settledRef.current.map((msg, i) => ({ ...msg, _idx: i }))}>
        {(item) => renderMessage(item, item._idx)}
      </Static>

      {error && <Box paddingX={1}><Text color="red">{error}</Text></Box>}
      {!agentReady && !error && <Box paddingX={1}><Text color="gray">Loading agent...</Text></Box>}
      {dynamicMessages.length > 0 && (
        <Box paddingX={1} flexDirection="column">
          {dynamicMessages.map((msg, i) => renderMessage(msg, settledRef.current.length + i))}
        </Box>
      )}

      <Box borderStyle="single" paddingX={1} flexShrink={0} flexGrow={0}>
        <Text color="green">&gt; </Text>
        <Text wrap="truncate">{input}</Text>
        <Text color="gray">█</Text>
        {isStreaming && !input && (
          <Text color="gray" dimColor> type to steer · esc to stop</Text>
        )}
      </Box>
    </Box>
  );
}
