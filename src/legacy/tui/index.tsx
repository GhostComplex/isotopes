import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { TuiOptions } from "./types.js";

export async function launchTui(values: { agent?: string }): Promise<void> {
  const options: TuiOptions = { agent: values.agent };
  const { waitUntilExit } = render(<App options={options} />);
  await waitUntilExit();
}
