import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { TuiOptions } from "./types.js";

export async function launchTui(values: {
  agent?: string;
  config?: string;
  message?: string;
}): Promise<void> {
  const options: TuiOptions = {
    agent: values.agent,
    config: values.config,
    message: values.message,
  };

  const { waitUntilExit } = render(<App options={options} />);
  await waitUntilExit();
}
