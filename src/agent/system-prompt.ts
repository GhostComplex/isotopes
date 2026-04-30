// src/agent/system-prompt.ts — Per-call system prompt derivation
//
// Pure(ish) helper: takes an agent's config + its tools and returns the
// fully-assembled system prompt. Reads workspace files via the stat-cache
// in workspace.ts, so unchanged files cost a single stat() per call and
// edits are picked up automatically (no watcher).

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "./types.js";
import { resolveAgentWorkspacePath } from "../paths.js";
import { resolveBundledSkillsDir } from "../legacy/skills/bundled-dir.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { buildToolGuardPrompt } from "../legacy/core/tools.js";

export async function deriveAgentSystemPrompt(
  config: AgentConfig,
  tools: AgentTool[],
): Promise<string> {
  const workspacePath = resolveAgentWorkspacePath(config);
  const workspace = await loadWorkspaceContext(workspacePath, {
    bundledPath: resolveBundledSkillsDir(),
  });
  const base = buildSystemPrompt(workspace);
  const toolGuard = buildToolGuardPrompt(tools, workspacePath);
  return [base, toolGuard].filter(Boolean).join("\n\n---\n\n");
}
