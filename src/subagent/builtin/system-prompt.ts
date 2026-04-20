// src/subagent/builtin/system-prompt.ts — System prompt builder for builtin subagents
// A builtin subagent gets a focused, task-scoped prompt — NOT the parent's SOUL.

import type { SubagentRole } from "../types.js";

/** Inputs for building a builtin subagent system prompt. */
export interface BuildPromptOptions {
  /** The task to perform — supplied by the caller (typically the parent agent). */
  task: string;
  /** The subagent's role; controls capability framing in the prompt. */
  role: SubagentRole;
  /** Optional fragment appended after the base prompt (e.g. workspace hints). */
  extraSystemPrompt?: string;
}

/**
 * Build the system prompt for a builtin (in-process) subagent run.
 *
 * The prompt is intentionally short and capability-aware. It does NOT inherit
 * the parent agent's SOUL — a subagent is a focused worker, not a continuation
 * of the parent persona.
 */
export function buildBuiltinSubagentSystemPrompt(options: BuildPromptOptions): string {
  const { task, role, extraSystemPrompt } = options;
  const sections: string[] = [];

  sections.push(
    "You are a focused subagent spawned to complete a single task and then exit.",
  );

  if (role === "leaf") {
    sections.push(
      "Capabilities: read-only inspection plus shell. You cannot spawn further subagents, " +
        "write or edit files, or fetch from the web. If the task requires those, return a " +
        "concise explanation of what is needed and stop.",
    );
  } else {
    sections.push(
      "Capabilities: you may delegate sub-tasks to further subagents. Prefer doing the work " +
        "yourself when reasonable; nest only when a sub-task is genuinely independent.",
    );
  }

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
