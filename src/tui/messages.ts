import type { ChatMessage, ContentItem } from "./types.js";

// ---------------------------------------------------------------------------
// Type guards for API content items (loosely typed from the wire)
// ---------------------------------------------------------------------------

function isTextContent(b: unknown): b is { type: "text"; text: string } {
  return !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string";
}

function isToolCall(b: unknown): b is { type: "toolCall"; id?: string; name: string; arguments?: unknown } {
  return !!b && typeof b === "object" && (b as Record<string, unknown>).type === "toolCall" && typeof (b as Record<string, unknown>).name === "string";
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

const STEER_PREFIX = "[Messages arrived while you were working]\n";

export function textContent(text: string): ContentItem[] {
  return [{ type: "text", text }];
}

export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const text = result.filter(isTextContent).map((b) => b.text).join("\n");
    if (text) return text;
  }
  if (result && typeof result === "object" && "content" in result) return extractResultText((result as { content: unknown }).content);
  return JSON.stringify(result);
}

export function historyToChatMessages(items: Array<{ role: string; type?: string; content?: unknown; timestamp?: number; toolCallId?: string }>): ChatMessage[] {
  const result: ChatMessage[] = [];
  let pending: { content: ContentItem[]; timestamp: Date } | null = null;

  const flush = () => {
    if (!pending || pending.content.length === 0) { pending = null; return; }
    for (const b of pending.content) {
      if (b.type === "tool" && !b.result) b.result = "✓";
    }
    result.push({ role: "assistant", content: pending.content, timestamp: pending.timestamp });
    pending = null;
  };

  for (const m of items) {
    const role = m.role ?? m.type;
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();

    if (role === "user") {
      const items: unknown[] = Array.isArray(m.content) ? m.content : [];
      let text = typeof m.content === "string" ? m.content : items.filter(isTextContent).map((b) => b.text).join("");
      if (!text) continue;
      if (text.startsWith(STEER_PREFIX)) text = text.slice(STEER_PREFIX.length);
      flush();
      result.push({ role: "user", content: textContent(text), timestamp: ts });
    } else if (role === "toolResult") {
      if (!pending) continue;
      const tc = m.toolCallId
        ? pending.content.find((b) => b.type === "tool" && b.id === m.toolCallId)
        : pending.content.find((b) => b.type === "tool" && !b.result);
      if (tc && tc.type === "tool") tc.result = "✓";
    } else if (role === "assistant") {
      flush();
      pending = { content: [], timestamp: ts };
      if (Array.isArray(m.content)) {
        for (const b of m.content as unknown[]) {
          if (isTextContent(b)) {
            pending.content.push({ type: "text", text: b.text });
          } else if (isToolCall(b)) {
            pending.content.push({
              type: "tool",
              id: String(b.id ?? ""),
              name: b.name,
              args: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
            });
          }
        }
      } else if (typeof m.content === "string") {
        pending.content.push({ type: "text", text: m.content });
      }
    }
  }
  flush();
  return result;
}
