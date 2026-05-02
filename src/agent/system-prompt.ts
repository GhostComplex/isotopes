import type { AgentConfig } from "./types.js";
import { resolveAgentWorkspacePath } from "../paths.js";
import { resolveBundledSkillsDir } from "../legacy/skills/bundled-dir.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";

export async function deriveAgentSystemPrompt(config: AgentConfig): Promise<string> {
  const workspacePath = resolveAgentWorkspacePath(config);
  const workspace = await loadWorkspaceContext(workspacePath, {
    bundledPath: resolveBundledSkillsDir(),
  });
  return buildSystemPrompt(workspace);
}
