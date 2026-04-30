import type { AgentSession } from "@mariozechner/pi-coding-agent";

// Patch all three fields: SDK's prompt() resets state.systemPrompt to
// _baseSystemPrompt each call, and _rebuildSystemPrompt fires on tool-list
// changes. If the SDK renames either private field, agents silently revert.
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
