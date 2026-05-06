import React, { useState } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { parseSlashCommand, dispatch, HELP_TEXT } from "./commands.js";
import type { ChatMessage, Screen } from "./types.js";
import { useChatSession } from "./useChatSession.js";
import { MessageView } from "./MessageView.js";

const MAX_VISIBLE_MESSAGES = 50;

interface Props {
  agentId: string;
  sessionKey: string;
  mode: "owned" | "attach";
  onSwitchScreen: (screen: Screen) => void;
}

export function ChatScreen({ agentId: propAgentId, sessionKey, mode, onSwitchScreen }: Props) {
  const { exit } = useApp();
  const session = useChatSession({ agentId: propAgentId, sessionKey, mode });
  const { messages, setMessages, isStreaming, agentReady, agentId, error } = session;
  const [input, setInput] = useState("");
  const [settled, setSettled] = useState<ChatMessage[]>([]);
  const isAttached = mode === "attach";

  const pushSystem = (content: string) => {
    setMessages((prev) => [...prev, { role: "system", content, timestamp: new Date() }]);
  };

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    if (isStreaming) {
      void session.steer(text);
      return;
    }

    const slash = parseSlashCommand(text);
    if (slash) {
      const handled = dispatch(slash.command, slash.args, {
        onNewChat: () => {
          if (isAttached) {
            pushSystem("/new is disabled while attached to another session. Use /sessions to switch.");
            return;
          }
          setSettled([]);
          void session.resetOwned();
        },
        onExit: () => exit(),
        onShowStatus: () => onSwitchScreen("status"),
        onShowSessions: () => onSwitchScreen("sessions"),
        onHelp: () => pushSystem(HELP_TEXT),
      });
      if (!handled) pushSystem(`Unknown command: /${slash.command}`);
      return;
    }
    void session.send(text);
  };

  useInput((ch, key) => {
    if (key.return) {
      handleSubmit();
    } else if (key.escape && isStreaming) {
      session.abort();
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (key.ctrl && ch === "c") {
      if (isStreaming) session.abort();
      else exit();
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  // Split: settled messages go to <Static> (terminal scrollback, never re-renders);
  // the active streaming message stays dynamic. Settled is append-only so Static
  // gets a stable reference and doesn't re-render old items.
  const visible = messages.slice(-MAX_VISIBLE_MESSAGES);
  const settledCount = isStreaming ? Math.max(visible.length - 1, 0) : visible.length;
  if (settledCount > settled.length) {
    const newSettled = visible.slice(settled.length, settledCount);
    // Defer state update via microtask to avoid setState-during-render warning.
    queueMicrotask(() => setSettled((prev) => (settledCount > prev.length ? [...prev, ...newSettled] : prev)));
  }
  const activeMessage = isStreaming && visible.length > 0 ? visible[visible.length - 1] : null;
  const contentWidth = (process.stdout.columns || 80) - 2;

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} flexShrink={0} flexGrow={0}>
        <Text bold>isotopes</Text>
        <Text> — agent: </Text>
        <Text color="cyan">{agentId || "loading..."}</Text>
        {isAttached && <Text color="magenta"> [attached: {sessionKey}]</Text>}
        {isStreaming && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      <Static items={settled.map((msg, i) => ({ msg, idx: i }))}>
        {({ msg, idx }) => (
          <MessageView key={msg.id ?? idx} message={msg} width={contentWidth} topMargin={idx > 0} />
        )}
      </Static>

      {error && <Box paddingX={1}><Text color="red">{error}</Text></Box>}
      {!agentReady && !error && <Box paddingX={1}><Text color="gray">Loading agent...</Text></Box>}
      {activeMessage && (
        <Box paddingX={1} flexDirection="column">
          <MessageView message={activeMessage} width={contentWidth} topMargin={settled.length > 0} />
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
