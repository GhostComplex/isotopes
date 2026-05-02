import type { AgentConfig } from "./types.js";
import { resolveAgentWorkspacePath } from "../paths.js";
import { resolveBundledSkillsDir } from "../legacy/skills/bundled-dir.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";

const SUBAGENT_DEFAULT_PROMPT =
  "You are a subagent in the Isotopes framework — a generic helper " +
  "spawned by another agent to handle one focused task.\n\n" +
  "Capabilities: read-only inspection (read, ls, grep, find). You cannot " +
  "spawn further agents, write or edit files, run shell, or fetch from the web. " +
  "If the task requires those, return a concise explanation of what is needed and stop.\n\n" +
  "Be terse. Report findings or completion in plain text. Do not narrate plans " +
  "before acting; just act and then summarize the result. Do not greet, sign off, " +
  "or refer to your model.";

export async function deriveAgentSystemPrompt(config: AgentConfig): Promise<string> {
  if (config.workspace === null) {
    return config.id === "subagent" ? SUBAGENT_DEFAULT_PROMPT : "";
  }
  const workspacePath = resolveAgentWorkspacePath(config);
  const workspace = await loadWorkspaceContext(workspacePath, {
    bundledPath: resolveBundledSkillsDir(),
  });
  return buildSystemPrompt(workspace);
}
