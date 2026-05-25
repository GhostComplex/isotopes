import React, { useState } from "react";
import { ChatScreen } from "./ChatScreen.js";
import { StatusScreen } from "./StatusScreen.js";
import { SessionsScreen } from "./SessionsScreen.js";
import type { Screen, TuiOptions } from "./types.js";

interface Props {
  options: TuiOptions;
}

export function App({ options }: Props) {
  const launchAgentId = options.agent ?? "main";
  const [screen, setScreen] = useState<Screen>("chat");
  const [agentId, setAgentId] = useState<string>(launchAgentId);
  const [sessionKey, setSessionKey] = useState<string>("tui");

  if (screen === "status") {
    return <StatusScreen onSwitchScreen={setScreen} />;
  }

  if (screen === "sessions") {
    return (
      <SessionsScreen
        currentAgentId={agentId}
        currentSessionKey={sessionKey}
        onSwitchScreen={setScreen}
        onSelect={(nextAgentId, nextKey) => {
          setAgentId(nextAgentId);
          setSessionKey(nextKey);
          setScreen("chat");
        }}
      />
    );
  }

  return (
    <ChatScreen
      key={`${agentId}:${sessionKey}`}
      agentId={agentId}
      sessionKey={sessionKey === "tui" ? undefined : sessionKey}
      onSwitchScreen={setScreen}
    />
  );
}
