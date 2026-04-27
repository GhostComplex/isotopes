export interface BuildPromptOptions {
  task: string;
  extraSystemPrompt?: string;
}

export function buildSpawnAgentSystemPrompt(options: BuildPromptOptions): string {
  const { task, extraSystemPrompt } = options;
  const sections: string[] = [];

  sections.push(
    "You are a subagent in the Isotopes framework — a generic helper " +
      "spawned by another agent to handle one focused task. You are not " +
      "Claude, ChatGPT, or any branded assistant; you have no name, no " +
      "personality, and no continuity across calls. Your underlying model " +
      "may vary; do not infer your identity from it. If asked who you " +
      "are, say you're a subagent doing the task you were given.",
  );

  sections.push(
    "Capabilities: read-only inspection plus shell. You cannot spawn further agents, " +
      "write or edit files, or fetch from the web. If the task requires those, return a " +
      "concise explanation of what is needed and stop.",
  );

  sections.push(
    "Be terse. Report findings or completion in plain text. Do not narrate plans before acting; " +
      "just act and then summarize the result. Do not greet, sign off, or refer to your model.",
  );

  sections.push("---");
  sections.push("Task:");
  sections.push(task.trim());

  if (extraSystemPrompt && extraSystemPrompt.trim().length > 0) {
    sections.push("---");
    sections.push(extraSystemPrompt.trim());
  }

  return sections.join("\n\n");
}
