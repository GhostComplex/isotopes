// src/subagent/builtin/tool-policy.ts — Role-based tool capability policy
// Decides which tools a builtin subagent may use, based on its role.

import { ToolRegistry, type ToolHandler } from "../../core/tools.js";
import type { SubagentRole } from "../types.js";

/** Tools never exposed to a builtin subagent regardless of role. */
export const DENY_ALWAYS: ReadonlySet<string> = new Set<string>([
  "write_file",
  "edit",
  "web_fetch",
  "web_search",
]);

/** Additional tools denied for "leaf" subagents (no nested spawning). */
export const DENY_LEAF: ReadonlySet<string> = new Set<string>([
  ...DENY_ALWAYS,
  "spawn_subagent",
]);

/** Resolved tool policy for a given subagent role. */
export interface BuiltinToolPolicy {
  /** Tool names denied for this role. */
  deny: ReadonlySet<string>;
}

/** Resolve the deny-list for a subagent role. */
export function resolveBuiltinToolPolicy(role: SubagentRole): BuiltinToolPolicy {
  switch (role) {
    case "leaf":
      return { deny: DENY_LEAF };
    case "orchestrator":
      return { deny: DENY_ALWAYS };
  }
}

/**
 * Build a new {@link ToolRegistry} containing only the tools from `parent`
 * that are not blocked by `policy`. The parent registry is left untouched.
 */
export function filterToolRegistry(
  parent: ToolRegistry,
  policy: BuiltinToolPolicy,
  agentId = "subagent",
): ToolRegistry {
  const filtered = new ToolRegistry(agentId);
  for (const tool of parent.list()) {
    if (policy.deny.has(tool.name)) continue;
    const entry = parent.get(tool.name);
    if (!entry) continue;
    const handler: ToolHandler = entry.handler;
    filtered.register(tool, handler);
  }
  return filtered;
}
