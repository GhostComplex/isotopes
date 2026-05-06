import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { TuiOptions } from "./types.js";

export async function launchTui(values: {
  agent?: string;
  session?: string;
}): Promise<void> {
  const options: TuiOptions = {
    agent: values.agent,
    session: values.session,
  };

  const { waitUntilExit } = render(<App options={options} />);
  await waitUntilExit();
}
