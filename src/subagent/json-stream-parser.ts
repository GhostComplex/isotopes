// src/subagent/json-stream-parser.ts — Parse newline-delimited JSON from Claude CLI stdout
// Each line of stdout from `claude --output-format=stream-json` is a JSON object
// representing a streaming event. This parser buffers partial lines and emits
// parsed ClaudeEvent objects.

import type { ClaudeEvent, ClaudeEventType } from "./claude-runner.js";

// ---------------------------------------------------------------------------
// Stream JSON event shapes (from Claude CLI `--output-format=stream-json`)
// ---------------------------------------------------------------------------

/** Raw JSON object from Claude CLI stdout. */
interface RawStreamEvent {
  type: string;
  // assistant_message / text_delta
  content?: string;
  // tool_use
  tool_name?: string;
  tool_input?: unknown;
  // tool_result
  tool_result?: string;
  // error
  error?: string;
  // subtype for assistant messages
  subtype?: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Incremental parser for newline-delimited JSON streams.
 *
 * Usage:
 * ```ts
 * const parser = new JsonStreamParser();
 * child.stdout.on("data", (chunk) => {
 *   for (const event of parser.push(chunk.toString())) {
 *     handleEvent(event);
 *   }
 * });
 * // After stream ends:
 * for (const event of parser.flush()) {
 *   handleEvent(event);
 * }
 * ```
 */
export class JsonStreamParser {
  private buffer = "";

  /**
   * Push a chunk of data and return any complete events parsed from it.
   * Handles partial lines by buffering across calls.
   */
  push(chunk: string): ClaudeEvent[] {
    this.buffer += chunk;
    const events: ClaudeEvent[] = [];

    // Split on newlines — last element may be a partial line
    const lines = this.buffer.split("\n");
    // Keep the last (potentially incomplete) fragment in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const event = parseLine(trimmed);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Flush any remaining buffered data as events.
   * Call this after the stream closes.
   */
  flush(): ClaudeEvent[] {
    const events: ClaudeEvent[] = [];
    const trimmed = this.buffer.trim();
    this.buffer = "";

    if (trimmed) {
      const event = parseLine(trimmed);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map raw stream event type strings to our normalized ClaudeEventType. */
function normalizeType(rawType: string): ClaudeEventType | null {
  switch (rawType) {
    case "assistant":
    case "assistant_message":
    case "message":
    case "content_block_delta":
    case "text":
      return "assistant_message";
    case "tool_use":
    case "content_block_start":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "thinking":
      return "thinking";
    case "error":
      return "error";
    case "result":
    case "done":
    case "message_stop":
      return "done";
    default:
      return null;
  }
}

/** Parse a single JSON line into a ClaudeEvent, or null if unparseable/irrelevant. */
function parseLine(line: string): ClaudeEvent | null {
  let raw: RawStreamEvent;
  try {
    raw = JSON.parse(line) as RawStreamEvent;
  } catch {
    // Not valid JSON — skip
    return null;
  }

  if (!raw.type) return null;

  const type = normalizeType(raw.type);
  if (!type) return null;

  const event: ClaudeEvent = { type };

  if (raw.content !== undefined) {
    event.content = raw.content;
  }
  if (raw.tool_name !== undefined) {
    event.toolName = raw.tool_name;
  }
  if (raw.tool_input !== undefined) {
    event.toolInput = raw.tool_input;
  }
  if (raw.tool_result !== undefined) {
    event.toolResult = raw.tool_result;
  }
  if (raw.error !== undefined) {
    event.error = raw.error;
  }

  return event;
}
