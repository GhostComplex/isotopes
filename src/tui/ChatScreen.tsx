import React, { useState } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { resolveCommand, HELP_TEXT } from "./commands.js";
import type { TuiMessage, Screen } from "./types.js";
import { useSession } from "./hooks.js";
import { tuiMessage } from "./messages.js";

interface Props {
  agentId: string;
  sessionKey: string;
  onSwitchScreen: (screen: Screen) => void;
}

export function ChatScreen({ agentId, sessionKey, onSwitchScreen }: Props) {
  const { exit } = useApp();
  const session = useSession(agentId, sessionKey);
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    const cmd = resolveCommand(text);
    if (cmd) {
      switch (cmd.action) {
        case "exit": exit(); break;
        case "status": onSwitchScreen("status"); break;
        case "sessions": onSwitchScreen("sessions"); break;
        case "help": session.pushMessage(tuiMessage("system", HELP_TEXT)); break;
      }
      return;
    }
    if (text.startsWith("/")) {
      session.pushMessage(tuiMessage("system", `Unknown command: ${text.split(" ")[0]}`));
      return;
    }
    session.sendMessage(text);
  };

  useInput((ch, key) => {
    if (key.return) {
      handleSubmit();
    } else if ((key.escape || (key.ctrl && ch === "c")) && session.isStreaming) {
      session.abortStream();
    } else if (key.ctrl && ch === "c") {
      exit();
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  const contentWidth = (process.stdout.columns || 80) - 2;

  const renderMessage = (msg: TuiMessage, i: number) => {
    const roleLabel = msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System";
    const roleColor = msg.role === "user" ? "green" : msg.role === "assistant" ? "blue" : "gray";

    return (
      <Box key={msg.id ?? i} flexDirection="column" width={contentWidth} marginTop={i > 0 ? 1 : 0}>
        <Text color={roleColor} bold>{roleLabel}:</Text>
        {msg.content.map((item, j) => (
          <Box key={j}>
            {item.type === "text"
              ? <Text wrap="wrap">{"  "}{item.text}</Text>
              : <Text color="gray" dimColor wrap="truncate-end">{"  "}{item.name}({item.args.length > 60 ? item.args.slice(0, 60) + "…" : item.args}){item.isError ? " ✗" : item.completed ? " ✓" : " …"}</Text>}
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} flexShrink={0} flexGrow={0}>
        <Text bold>isotopes</Text>
        <Text> — agent: </Text>
        <Text color="cyan">{session.effectiveAgentId || "loading..."}</Text>
        <Text color="magenta"> [session: {sessionKey}]</Text>
        {session.isStreaming && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      <Static items={session.settled.map((msg, i) => ({ ...msg, _idx: i }))}>
        {(item) => renderMessage(item, item._idx)}
      </Static>

      {session.error && <Box paddingX={1}><Text color="red">{session.error}</Text></Box>}
      {!session.agentReady && !session.error && <Box paddingX={1}><Text color="gray">Loading agent...</Text></Box>}
      {session.dynamic.length > 0 && (
        <Box paddingX={1} flexDirection="column">
          {session.dynamic.map((msg, i) => renderMessage(msg, session.settled.length + i))}
        </Box>
      )}

      <Box borderStyle="single" paddingX={1} flexShrink={0} flexGrow={0}>
        <Text color="green">&gt; </Text>
        <Text wrap="truncate">{input}</Text>
        <Text color="gray">█</Text>
        {session.isStreaming && !input && (
          <Text color="gray" dimColor> type to steer · esc to stop</Text>
        )}
      </Box>
    </Box>
  );
}
