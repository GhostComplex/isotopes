import React, { useState } from "react";
import { ChatScreen } from "./ChatScreen.js";
import { StatusScreen } from "./StatusScreen.js";
import { SessionsScreen } from "./SessionsScreen.js";
import type { Screen, TuiOptions } from "./types.js";

interface Props {
  options: TuiOptions;
}

function modeFor(sessionKey: string): "owned" | "attach" {
  return sessionKey === "tui" || sessionKey.startsWith("tui:") ? "owned" : "attach";
}

export function App({ options }: Props) {
  const [screen, setScreen] = useState<Screen>("chat");
  const [sessionKey, setSessionKey] = useState<string>("tui");

  if (screen === "status") {
    return <StatusScreen onSwitchScreen={setScreen} />;
  }

  if (screen === "sessions") {
    return (
      <SessionsScreen
        currentSessionKey={sessionKey}
        onSwitchScreen={setScreen}
        onSelect={(key) => {
          setSessionKey(key);
          setScreen("chat");
        }}
      />
    );
  }

  return (
    <ChatScreen
      key={sessionKey}
      options={options}
      sessionKey={sessionKey}
      mode={modeFor(sessionKey)}
      onSwitchScreen={setScreen}
    />
  );
}
