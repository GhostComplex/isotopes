import type { ChatMessage, ContentBlock } from "./types.js";

export const STEER_PREFIX = "[Messages arrived while you were working]\n";

export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const texts: string[] = [];
    for (const block of result as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    if (texts.length > 0) return texts.join("\n");
  }
  if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    return extractResultText((result as Record<string, unknown>).content);
  }
  return JSON.stringify(result);
}

export interface HistoryItem {
  role: string;
  type?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
}

export function historyToChatMessages(items: HistoryItem[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let current: { text: string; blocks: ContentBlock[]; timestamp: Date } | null = null;

  const flushAssistant = () => {
    if (current && (current.text || current.blocks.length > 0)) {
      for (const b of current.blocks) {
        if (b.type === "tool" && !b.result) b.result = "✓";
      }
      result.push({ role: "assistant", content: current.text, blocks: current.blocks.length > 0 ? current.blocks : undefined, timestamp: current.timestamp });
    }
    current = null;
  };

  for (const m of items) {
    const role = m.role ?? m.type;
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();

    if (role === "user") {
      let text = "";
      if (typeof m.content === "string") {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") text += b.text;
        }
      }
      if (!text) continue;
      if (text.startsWith(STEER_PREFIX)) text = text.slice(STEER_PREFIX.length);
      flushAssistant();
      result.push({ role: "user", content: text, timestamp: ts });
    } else if (role === "toolResult") {
      if (current && m.toolCallId) {
        const tc = current.blocks.find((b) => b.type === "tool" && b.id === m.toolCallId);
        if (tc && tc.type === "tool" && !tc.result) tc.result = "✓";
      } else if (current) {
        for (const b of current.blocks) {
          if (b.type === "tool" && !b.result) { b.result = "✓"; break; }
        }
      }
    } else if (role === "assistant") {
      flushAssistant();
      current = { text: "", blocks: [], timestamp: ts };
      if (Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") {
            current.text += b.text;
            current.blocks.push({ type: "text", text: b.text });
          } else if (b.type === "toolCall" && typeof b.name === "string") {
            current.blocks.push({
              type: "tool",
              id: String(b.id ?? ""),
              name: b.name,
              args: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
            });
          }
        }
      } else if (typeof m.content === "string") {
        current.text += m.content;
        current.blocks.push({ type: "text", text: m.content });
      }
    }
  }
  flushAssistant();
  return result;
}
