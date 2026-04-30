// src/agent/system-prompt.ts — Per-call system prompt derivation
//
// Pure(ish) helper: takes an agent's config and returns the fully-assembled
// system prompt. Reads workspace files via the stat-cache in workspace.ts, so
// unchanged files cost a single stat() per call and edits are picked up
// automatically (no watcher).
//
// Tools are NOT injected here — pi-coding-agent's native tool-call API delivers
// name + description + JSON schema to the model directly. Repeating that in
// system-prompt text would just burn tokens.

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
