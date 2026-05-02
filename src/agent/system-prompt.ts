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
  const workspacePath = resolveAgentWorkspacePath(config);
  const workspace = await loadWorkspaceContext(workspacePath, {
    bundledPath: resolveBundledSkillsDir(),
  });
  const fromWorkspace = buildSystemPrompt(workspace);
  if (config.id === "subagent") {
    return workspace ? `${SUBAGENT_DEFAULT_PROMPT}\n\n---\n\n${fromWorkspace}` : SUBAGENT_DEFAULT_PROMPT;
  }
  return fromWorkspace;
}
