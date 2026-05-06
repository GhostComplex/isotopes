import React, { useState } from "react";
import { ChatScreen } from "./ChatScreen.js";
import { StatusScreen } from "./StatusScreen.js";
import { SessionsScreen } from "./SessionsScreen.js";
import type { Screen, TuiOptions } from "./types.js";

interface Props {
  options: TuiOptions;
}

export function App({ options }: Props) {
  const [screen, setScreen] = useState<Screen>("chat");
  const [attachKey, setAttachKey] = useState<string | undefined>(undefined);

  if (screen === "status") {
    return <StatusScreen onSwitchScreen={setScreen} />;
  }

  if (screen === "sessions") {
    return (
      <SessionsScreen
        onSwitchScreen={setScreen}
        onSelect={(key) => {
          setAttachKey(key);
          setScreen("chat");
        }}
      />
    );
  }

  return (
    <ChatScreen
      key={attachKey ?? "owned"}
      options={options}
      attachKey={attachKey}
      onSwitchScreen={setScreen}
    />
  );
}
