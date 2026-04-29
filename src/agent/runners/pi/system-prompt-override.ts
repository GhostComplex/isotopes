// src/agent/runners/pi/system-prompt-override.ts — Force a system prompt onto
// an existing AgentSession by patching SDK private fields.

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/**
 * Set state.systemPrompt + _baseSystemPrompt + _rebuildSystemPrompt together —
 * the SDK's prompt() resets state.systemPrompt to _baseSystemPrompt on each
 * call when an extensionRunner is present (always with customTools), and
 * calls _rebuildSystemPrompt on tool-list changes. We patch all three so the
 * override sticks. The cast is required because _baseSystemPrompt and
 * _rebuildSystemPrompt are private to AgentSession; if SDK renames either,
 * agents will silently revert to default identity (visible regression).
 */
export function overrideSessionSystemPrompt(session: AgentSession, override: string): void {
  const prompt = override.trim();
  session.agent.state.systemPrompt = prompt;
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;
}
