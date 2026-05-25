import type { TuiMessage, ContentItem } from "./types.js";

// ---------------------------------------------------------------------------
// Type guards for API content items (loosely typed from the wire)
// ---------------------------------------------------------------------------

function isText(b: unknown): b is { type: "text"; text: string } {
  return !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string";
}

function isToolCall(b: unknown): b is { type: "toolCall"; id?: string; name: string; arguments?: unknown } {
  return !!b && typeof b === "object" && (b as Record<string, unknown>).type === "toolCall" && typeof (b as Record<string, unknown>).name === "string";
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function tuiMessage(role: TuiMessage["role"], content: string | ContentItem[], timestamp = new Date()): TuiMessage {
  return {
    role,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    timestamp,
  };
}

export function historyToTuiMessages(items: Array<{ role: string; type?: string; content?: unknown; timestamp?: number; toolCallId?: string }>): TuiMessage[] {
  const toolResults = new Map(
    items
      .filter((m) => (m.role ?? m.type) === "toolResult" && m.toolCallId)
      .map((m) => [m.toolCallId!, (m as { isError?: boolean }).isError ?? false] as const),
  );

  function parseUserText(m: { content?: unknown }): string {
    const items: unknown[] = Array.isArray(m.content) ? m.content : [];
    return typeof m.content === "string" ? m.content : items.filter(isText).map((b) => b.text).join("");
  }

  function parseAssistantContent(m: { content?: unknown }): ContentItem[] {
    if (Array.isArray(m.content)) {
      return (m.content as unknown[]).flatMap((b): ContentItem[] => {
        if (isText(b)) return [{ type: "text", text: b.text }];
        if (isToolCall(b)) {
          const id = String(b.id ?? "");
          return [{
            type: "tool",
            id,
            name: b.name,
            args: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
            completed: true,
            isError: toolResults.get(id) ?? false,
          }];
        }
        return [];
      });
    }
    if (typeof m.content === "string") return [{ type: "text", text: m.content }];
    return [];
  }

  return items
    .filter((m) => (m.role ?? m.type) !== "toolResult")
    .map((m) => {
      const role = m.role ?? m.type;
      const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();
      if (role === "user") {
        const text = parseUserText(m);
        return text ? tuiMessage("user", text, ts) : null;
      }
      if (role === "assistant") return tuiMessage("assistant", parseAssistantContent(m), ts);
      return null;
    })
    .filter((m): m is TuiMessage => m !== null && m.content.length > 0);
}
