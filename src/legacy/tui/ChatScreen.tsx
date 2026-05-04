import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { randomUUID } from "node:crypto";
import { parseSlashCommand, dispatch, HELP_TEXT } from "./commands.js";
import type { ChatMessage, ContentBlock, TuiOptions, Screen, SSEEvent } from "./types.js";
import * as api from "./api.js";

const MAX_VISIBLE_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 20;

export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const texts: string[] = [];
    for (const block of result as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    if (texts.length > 0) return texts.join("\n");
  }
  if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    return extractResultText((result as Record<string, unknown>).content);
  }
  return JSON.stringify(result);
}

export function historyToChatMessages(items: Array<{ role: string; type?: string; content?: unknown; timestamp?: number; toolCallId?: string }>): ChatMessage[] {
  const result: ChatMessage[] = [];
  let current: { text: string; blocks: ContentBlock[]; timestamp: Date } | null = null;

  const flushAssistant = () => {
    if (current && (current.text || current.blocks.length > 0)) {
      // Mark all tool calls as completed in history
      for (const b of current.blocks) {
        if (b.type === "tool" && !b.result) b.result = "✓";
      }
      result.push({ role: "assistant", content: current.text, blocks: current.blocks.length > 0 ? current.blocks : undefined, timestamp: current.timestamp });
    }
    current = null;
  };

  for (const m of items) {
    const role = m.role ?? m.type;
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();

    if (role === "user") {
      let text = "";
      if (typeof m.content === "string") {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") text += b.text;
        }
      }
      if (!text) continue;
      const steerPrefix = "[Messages arrived while you were working]\n";
      if (text.startsWith(steerPrefix)) text = text.slice(steerPrefix.length);
      flushAssistant();
      result.push({ role: "user", content: text, timestamp: ts });
    } else if (role === "toolResult") {
      if (current && m.toolCallId) {
        const tc = current.blocks.find((b) => b.type === "tool" && b.id === m.toolCallId);
        if (tc && tc.type === "tool" && !tc.result) tc.result = "✓";
      } else if (current) {
        for (const b of current.blocks) {
          if (b.type === "tool" && !b.result) { b.result = "✓"; break; }
        }
      }
    } else if (role === "assistant") {
      flushAssistant();
      current = { text: "", blocks: [], timestamp: ts };
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") {
            current.text += b.text;
            current.blocks.push({ type: "text", text: b.text });
          } else if (b.type === "toolCall" && typeof b.name === "string") {
            current.blocks.push({
              type: "tool",
              id: String(b.id ?? ""),
              name: b.name,
              args: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
            });
          }
        }
      } else if (typeof m.content === "string") {
        current.text += m.content;
        current.blocks.push({ type: "text", text: m.content });
      }
    }
  }
  flushAssistant();
  return result;
}

interface Props {
  options: TuiOptions;
  onSwitchScreen: (screen: Screen) => void;
}

export function ChatScreen({ options, onSwitchScreen }: Props) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [agentId, setAgentId] = useState(options.agent ?? "");
  const [error, setError] = useState<string | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const attachAbortRef = useRef<AbortController | null>(null);
  const pendingSteerRef = useRef<ChatMessage[]>([]);
  const settledRef = useRef<ChatMessage[]>([]);
  const autoMessageSent = useRef(false);

  const initAgent = useCallback(async (requestedAgent?: string) => {
    setAgentReady(false);
    setError(null);
    try {
      const running = await api.isDaemonRunning();
      if (!running) {
        setError("Daemon not running. Start with: isotopes start");
        return;
      }

      let resolvedAgentId = requestedAgent;
      if (!resolvedAgentId) {
        const sessions = await api.fetchSessions();
        resolvedAgentId = sessions[0]?.agentId;
        if (!resolvedAgentId) {
          setError("No agents available");
          return;
        }
      }

      if (options.session) {
        sessionKeyRef.current = options.session;
        setAgentId(resolvedAgentId);
        const { items: history } = await api.getHistory(resolvedAgentId, options.session);
        const chatMessages = historyToChatMessages(history);
        setMessages(chatMessages);
        const attachAbort = new AbortController();
        attachAbortRef.current = attachAbort;
        void (async () => {
          try {
            await api.attachStream(resolvedAgentId, options.session!, (m) => {
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

      const session = await api.createSession(resolvedAgentId, "tui:main");
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
  }, [options.session]);

  useEffect(() => {
    void initAgent(options.agent);
    return () => {
      abortRef.current?.abort();
      attachAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (agentReady && options.message && !autoMessageSent.current) {
      autoMessageSent.current = true;
      void sendMessage(options.message);
    }
  }, [agentReady]);

  const sendMessage = async (text: string) => {
    if (!sessionKeyRef.current || isStreaming) return;
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    const sessionKey = sessionKeyRef.current;
    let blocks: ContentBlock[] = [];
    const abort = new AbortController();
    abortRef.current = abort;
    let streamMsgId = randomUUID();
    pendingSteerRef.current = [];

    const updateAssistant = () => {
      const fullText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const msgId = streamMsgId;
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
    };

    const handleEvent = (e: SSEEvent) => {
      if (e.type === "text_delta") {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === "text") {
          lastBlock.text += e.text;
        } else {
          blocks.push({ type: "text", text: e.text });
        }
        updateAssistant();
      } else if (e.type === "tool_call") {
        blocks.push({ type: "tool", id: e.toolCallId, name: e.toolName, args: typeof e.args === "string" ? e.args : JSON.stringify(e.args) });
        updateAssistant();
      } else if (e.type === "tool_result") {
        const tc = blocks.find((b): b is ContentBlock & { type: "tool" } => b.type === "tool" && b.id === e.toolCallId);
        if (tc) {
          tc.result = extractResultText(e.result);
          tc.isError = e.isError;
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
        setMessages((prev) => [...prev, { role: "system", content: `Error: ${e.message}`, timestamp: new Date() }]);
      }
    };

    try {
      await api.sendMessage(agentId, sessionKey, text, handleEvent, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, { role: "system", content: `Error: ${msg}`, timestamp: new Date() }]);
      }
    } finally {
      if (pendingSteerRef.current.length > 0) {
        const flushed = pendingSteerRef.current.splice(0);
        setMessages((prev) => [...prev, ...flushed]);
      }
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    if (isStreaming) {
      const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date() };
      pendingSteerRef.current.push(userMsg);
      void api.steerMessage(agentId, sessionKeyRef.current!, text).catch((err) => {
        setMessages((prev) => [...prev, { role: "system", content: `Steer failed: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date() }]);
      });
      return;
    }

    const slash = parseSlashCommand(text);
    if (slash) {
      const handled = dispatch(slash.command, slash.args, {
        onNewChat: () => {
          setMessages([]);
          settledRef.current = [];
          setIsStreaming(true);
          (async () => {
            try {
              if (sessionKeyRef.current) {
                await api.deleteSession(agentId, sessionKeyRef.current).catch(() => {});
              }
              const session = await api.createSession(agentId, "tui:main");
              sessionKeyRef.current = session.key;
              setMessages([{ role: "system", content: "New conversation started.", timestamp: new Date() }]);
            } catch (err) {
              setMessages([{ role: "system", content: `Error: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date() }]);
            } finally {
              setIsStreaming(false);
            }
          })();
        },
        onSwitchAgent: (id) => void initAgent(id),
        onExit: () => exit(),
        onShowStatus: () => onSwitchScreen("status"),
        onShowChat: () => {},
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

  // Split: settled messages go to Static (terminal scrollback), active message stays dynamic.
  // settledRef is append-only so Static gets a stable reference and doesn't re-render old items.
  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);
  const settledCount = isStreaming ? Math.max(visible.length - 1, 0) : visible.length;
  if (settledCount > settledRef.current.length) {
    const newSettled = visible.slice(settledRef.current.length, settledCount);
    settledRef.current = [...settledRef.current, ...newSettled];
  }
  const activeMessage = isStreaming && visible.length > 0 ? visible[visible.length - 1] : null;

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} flexShrink={0} flexGrow={0}>
        <Text bold>isotopes</Text>
        <Text> — agent: </Text>
        <Text color="cyan">{agentId || "loading..."}</Text>
        {isStreaming && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      <Static items={settledRef.current.map((msg, i) => ({ ...msg, _idx: i }))}>
        {(item) => renderMessage(item, item._idx)}
      </Static>

      {error && <Box paddingX={1}><Text color="red">{error}</Text></Box>}
      {!agentReady && !error && <Box paddingX={1}><Text color="gray">Loading agent...</Text></Box>}
      {activeMessage && <Box paddingX={1} flexDirection="column">{renderMessage(activeMessage, settledRef.current.length)}</Box>}

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
