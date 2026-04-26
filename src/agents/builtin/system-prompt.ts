export interface BuildPromptOptions {
  task: string;
  extraSystemPrompt?: string;
}

export function buildBuiltinSubagentSystemPrompt(options: BuildPromptOptions): string {
  const { task, extraSystemPrompt } = options;
  const sections: string[] = [];

  sections.push(
    "You are a focused subagent spawned to complete a single task and then exit.",
  );

  sections.push(
    "Capabilities: read-only inspection plus shell. You cannot spawn further subagents, " +
      "write or edit files, or fetch from the web. If the task requires those, return a " +
      "concise explanation of what is needed and stop.",
  );

  sections.push(
    "Be terse. Report findings or completion in plain text. Do not narrate plans before acting; " +
      "just act and then summarize the result.",
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
