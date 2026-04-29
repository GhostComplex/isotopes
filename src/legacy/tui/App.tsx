import React, { useState } from "react";
import { ChatScreen } from "./ChatScreen.js";
import { StatusScreen } from "./StatusScreen.js";
import type { Screen, TuiOptions } from "./types.js";

interface Props {
  options: TuiOptions;
}

export function App({ options }: Props) {
  const [screen, setScreen] = useState<Screen>("chat");

  if (screen === "status") {
    return <StatusScreen onSwitchScreen={setScreen} />;
  }

  return <ChatScreen options={options} onSwitchScreen={setScreen} />;
}
