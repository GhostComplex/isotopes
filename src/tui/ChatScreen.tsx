import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { parseSlashCommand, dispatch, HELP_TEXT } from "./commands.js";
import type { ChatMessage, ToolCallEntry, TuiOptions, Screen, SSEEvent } from "./types.js";
import * as api from "./api.js";

const MAX_VISIBLE_MESSAGES = 50;
const MAX_HISTORY_MESSAGES = 20;

function historyMessageToChatMessage(m: { role: string; content?: unknown; timestamp?: number }): ChatMessage | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  const role = m.role as "user" | "assistant";

  let text = "";
  if (typeof m.content === "string") {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
    }
  }

  const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();
  return { role, content: text, timestamp: ts };
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

      const session = await api.createSession(resolvedAgentId, "tui:main");
      sessionKeyRef.current = session.sessionKey;
      setAgentId(session.agentId);

      if (session.resumed) {
        const { items: history } = await api.getHistory(session.agentId, session.sessionKey);
        const chatMessages = history
          .map(historyMessageToChatMessage)
          .filter((m): m is ChatMessage => m !== null)
          .slice(-MAX_HISTORY_MESSAGES);
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

  useEffect(() => {
    void initAgent(options.agent);
    return () => {
      abortRef.current?.abort();
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
    let responseText = "";
    const toolCalls: ToolCallEntry[] = [];
    const abort = new AbortController();
    abortRef.current = abort;

    const handleEvent = (e: SSEEvent) => {
      if (e.type === "text_delta") {
        responseText += e.text;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, content: responseText, toolCalls: [...toolCalls] }];
          }
          return [...prev, { role: "assistant", content: responseText, toolCalls: [...toolCalls], timestamp: new Date() }];
        });
      } else if (e.type === "tool_call") {
        toolCalls.push({ id: e.toolCallId, name: e.toolName, args: typeof e.args === "string" ? e.args : JSON.stringify(e.args) });
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, toolCalls: [...toolCalls] }];
          }
          return prev;
        });
      } else if (e.type === "tool_result") {
        const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
        const tc = toolCalls.find((t) => t.id === e.toolCallId);
        if (tc) {
          tc.result = output;
          tc.isError = e.isError;
        }
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
      abortRef.current = null;
      setIsStreaming(false);
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
          setMessages([]);
          setIsStreaming(true);
          (async () => {
            try {
              const session = await api.createSession(agentId);
              sessionKeyRef.current = session.sessionKey;
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
    if (isStreaming) return;
    if (key.return) {
      handleSubmit();
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (key.ctrl && ch === "c") {
      exit();
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);

  return (
    <Box flexDirection="column" height={process.stdout.rows}>
      <Box borderStyle="single" paddingX={1}>
        <Text bold>isotopes</Text>
        <Text> — agent: </Text>
        <Text color="cyan">{agentId || "loading..."}</Text>
        {isStreaming && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {error && <Text color="red">{error}</Text>}
        {!agentReady && !error && <Text color="gray">Loading agent...</Text>}
        {visible.map((msg, i) => (
          <Box key={i} flexDirection="column">
            <Text>
              <Text color={msg.role === "user" ? "green" : msg.role === "assistant" ? "blue" : "gray"} bold>
                {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}
              </Text>
              <Text>: {msg.content}</Text>
            </Text>
            {msg.toolCalls?.map((tc) => (
              <Text key={tc.id} color="gray" dimColor>
                {"  "}🔧 {tc.name}{tc.result ? ` → ${tc.result.slice(0, 80)}` : " ..."}
              </Text>
            ))}
          </Box>
        ))}
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text color="green">&gt; </Text>
        <Text>{input}</Text>
        <Text color="gray">█</Text>
      </Box>
    </Box>
  );
}
