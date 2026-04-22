// src/core/context.ts — Prompt preparation transforms for context management.
// All functions are pure: AgentMessage[] in, new AgentMessage[] out, no mutation.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// pruneImages — replace old image blocks with placeholders
// ---------------------------------------------------------------------------

export interface PruneImagesOptions {
  keepRecentTurns?: number;
}

export function pruneImages(messages: AgentMessage[], opts?: PruneImagesOptions): AgentMessage[] {
  const keepRecentTurns = opts?.keepRecentTurns ?? 3;

  let protectFrom = 0;
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount >= keepRecentTurns) {
        protectFrom = i;
        break;
      }
    }
  }

  return messages.map((msg, i) => {
    if (i >= protectFrom) return msg;
    const m = msg as unknown as { content?: unknown[] };
    if (!Array.isArray(m.content)) return msg;

    const hasImage = (m.content as Array<Record<string, unknown>>).some(
      (block) => block.type === "image",
    );
    if (!hasImage) return msg;

    return {
      ...msg,
      content: (m.content as Array<Record<string, unknown>>).map((block) => {
        if (block.type === "image") {
          return { type: "text", text: "[image data removed — already processed by model]" };
        }
        return block;
      }),
    } as unknown as AgentMessage;
  });
}
