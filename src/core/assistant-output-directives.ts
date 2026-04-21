// src/core/assistant-output-directives.ts — Channel-agnostic output directives
//
// Inline tags the agent can include in its response text to request delivery
// metadata from the transport. The transport parses and strips them before
// the user-visible message is sent, then applies the requested behavior on
// channels that support it (e.g. Discord native replies).
//
// Currently only reply tags are defined. Future tags (media attachments,
// voice-note hints, etc.) belong here too.

const ASSISTANT_OUTPUT_DIRECTIVES = `# Assistant Output Directives

When you reply on a chat surface, you may include the following inline tags
in your message to request delivery metadata. Tags are stripped from the
user-visible text and are only honored on channels that support the
underlying feature; channels without support silently ignore them.

- \`[[reply_to_current]]\` — render this message as a native reply to the
  message that triggered the current turn. Prefer this form.
- \`[[reply_to: <message-id>]]\` — render this message as a native reply to
  a specific message id. Use only when the id was explicitly given to you
  (by the user or by a tool result).

Place the tag at the start of your response, before any other text.
Whitespace inside the brackets is allowed. Tags are channel-agnostic — each
transport (Discord, Feishu, etc.) renders them in the platform's native
reply / quote primitive where available.`;

/**
 * Channel-agnostic system-prompt fragment that teaches the agent how to use
 * inline output directives (reply tags, etc.). Returned as a single string
 * suitable for concatenation into the assembled system prompt.
 */
export function buildAssistantOutputDirectives(): string {
  return ASSISTANT_OUTPUT_DIRECTIVES;
}
