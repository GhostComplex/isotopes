import type { ChatMessage, ContentBlock } from "./types.js";

// ---------------------------------------------------------------------------
// Type guards for API content blocks (loosely typed from the wire)
// ---------------------------------------------------------------------------

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string";
}

function isToolCallBlock(b: unknown): b is { type: "toolCall"; id?: string; name: string; arguments?: unknown } {
  return !!b && typeof b === "object" && (b as Record<string, unknown>).type === "toolCall" && typeof (b as Record<string, unknown>).name === "string";
}

function hasContent(v: unknown): v is { content: unknown } {
  return !!v && typeof v === "object" && "content" in (v as Record<string, unknown>);
}

function extractText(blocks: unknown[]): string {
  return blocks.filter(isTextBlock).map((b) => b.text).join("");
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

const STEER_PREFIX = "[Messages arrived while you were working]\n";

export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const text = result.filter(isTextBlock).map((b) => b.text).join("\n");
    if (text) return text;
  }
  if (hasContent(result)) return extractResultText(result.content);
  return JSON.stringify(result);
}

export function historyToChatMessages(items: Array<{ role: string; type?: string; content?: unknown; timestamp?: number; toolCallId?: string }>): ChatMessage[] {
  const result: ChatMessage[] = [];
  let pending: { text: string; blocks: ContentBlock[]; timestamp: Date } | null = null;

  const flush = () => {
    if (!pending || (!pending.text && pending.blocks.length === 0)) { pending = null; return; }
    for (const b of pending.blocks) {
      if (b.type === "tool" && !b.result) b.result = "✓";
    }
    result.push({
      role: "assistant",
      content: pending.text,
      blocks: pending.blocks.length > 0 ? pending.blocks : undefined,
      timestamp: pending.timestamp,
    });
    pending = null;
  };

  for (const m of items) {
    const role = m.role ?? m.type;
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();

    if (role === "user") {
      let text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? extractText(m.content) : "";
      if (!text) continue;
      if (text.startsWith(STEER_PREFIX)) text = text.slice(STEER_PREFIX.length);
      flush();
      result.push({ role: "user", content: text, timestamp: ts });
    } else if (role === "toolResult") {
      if (!pending) continue;
      const tc = m.toolCallId
        ? pending.blocks.find((b) => b.type === "tool" && b.id === m.toolCallId)
        : pending.blocks.find((b) => b.type === "tool" && !b.result);
      if (tc && tc.type === "tool") tc.result = "✓";
    } else if (role === "assistant") {
      flush();
      pending = { text: "", blocks: [], timestamp: ts };
      if (Array.isArray(m.content)) {
        for (const b of m.content as unknown[]) {
          if (isTextBlock(b)) {
            pending.text += b.text;
            pending.blocks.push({ type: "text", text: b.text });
          } else if (isToolCallBlock(b)) {
            pending.blocks.push({
              type: "tool",
              id: String(b.id ?? ""),
              name: b.name,
              args: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
            });
          }
        }
      } else if (typeof m.content === "string") {
        pending.text += m.content;
        pending.blocks.push({ type: "text", text: m.content });
      }
    }
  }
  flush();
  return result;
}
