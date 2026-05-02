import type { AgentConfig } from "./types.js";
import { resolveAgentWorkspacePath } from "../paths.js";
import { resolveBundledSkillsDir } from "../legacy/skills/bundled-dir.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";

export async function deriveAgentSystemPrompt(config: AgentConfig): Promise<string> {
  if (config.workspace === null) {
    return config.defaultSystemPrompt ?? "";
  }
  const workspacePath = resolveAgentWorkspacePath(config);
  const workspace = await loadWorkspaceContext(workspacePath, {
    bundledPath: resolveBundledSkillsDir(),
  });
  const fromWorkspace = buildSystemPrompt(workspace);
  if (config.defaultSystemPrompt) {
    return workspace
      ? `${config.defaultSystemPrompt}\n\n---\n\n${fromWorkspace}`
      : config.defaultSystemPrompt;
  }
  return fromWorkspace;
}
