# Design: Message Metadata Injection (#198)

## Summary

Inject structured message metadata (sender info, timestamps, channel info, reply-to) into user message content so the model can see and use this context.

## Current State

- `MessageMetadata` interface exists in `src/transports/message-metadata.ts`
- `extractDiscordMetadata(msg)` extracts metadata from Discord.js messages
- Metadata is stored in `message.metadata` but **not visible to the model**
- Model only sees the raw text content

## Proposed Design

### 1. New function: `formatMetadataContext`

Add to `src/transports/message-metadata.ts`:

```ts
/**
 * Format message metadata into a context block string.
 * Returns empty string if no metadata provided.
 */
export function formatMetadataContext(metadata: MessageMetadata): string {
  const sender = metadata.sender.displayName || metadata.sender.username;
  const channel = metadata.channel.name || `#${metadata.channel.id}`;
  const time = new Date(metadata.timestamps.sent).toISOString();
  
  let context = `[${sender} in ${channel} at ${time}]`;
  if (metadata.replyTo) {
    context += ` [replying to message ${metadata.replyTo}]`;
  }
  return context;
}
```

Output format example:
```
[testuser in #general at 2025-04-13T10:30:00.000Z]
Hello world
```

Or with reply-to:
```
[testuser in #general at 2025-04-13T10:30:00.000Z] [replying to message 123456789]
Can you elaborate on that?
```

### 2. Injection point: `buildHistoryContext`

Extend `buildHistoryContext` to optionally include metadata for the current message:

```ts
export function buildHistoryContext(
  entries: HistoryEntry[],
  currentMessage: string,
  currentMetadata?: MessageMetadata,
): string {
  let result = currentMessage;
  
  // Prepend metadata context if available
  if (currentMetadata) {
    result = `${formatMetadataContext(currentMetadata)}\n${result}`;
  }
  
  // Prepend history entries if available
  if (entries.length > 0) {
    const lines = entries.map((e) => `${e.sender}: ${e.body}`);
    result = `${HISTORY_MARKER}\n${lines.join("\n")}\n\n${CURRENT_MARKER}\n${result}`;
  }
  
  return result;
}
```

### 3. Update Discord transport

In `src/transports/discord.ts`, pass metadata to `buildHistoryContext`:

```ts
const messageMetadata = extractDiscordMetadata(msg);
const enrichedContent = buildHistoryContext(historyEntries, content, messageMetadata);
```

### 4. History entries get metadata too

Update `HistoryEntry` to include optional metadata fields:

```ts
export interface HistoryEntry {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  channelName?: string;  // NEW
  replyTo?: string;      // NEW
}
```

Format history entries with richer context:

```ts
const lines = entries.map((e) => {
  const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
  return `[${e.sender}${time ? ` at ${time}` : ''}] ${e.body}`;
});
```

## Files Changed

1. `src/transports/message-metadata.ts` — add `formatMetadataContext`
2. `src/core/channel-history.ts` — update `HistoryEntry`, `buildHistoryContext`
3. `src/transports/discord.ts` — extract metadata, pass to `buildHistoryContext`
4. Tests for all above

## Alternatives Considered

**A. XML-style blocks**
```xml
<message_context sender="testuser" channel="general" time="..." />
```
Pro: More structured. Con: Verbose, models handle plain text fine.

**B. Inject in `preparePromptMessages`**
Pro: Works for all transports. Con: Metadata isn't available at that layer — it's stripped before reaching context preparation.

**C. System prompt injection**
Put "Current user is X in channel Y" in system prompt. Con: Doesn't scale for multi-turn conversations where sender may vary.

## Testing

1. Unit tests for `formatMetadataContext`
2. Update `buildHistoryContext` tests
3. Integration: verify metadata appears in session messages

## Migration

None — this is additive. Existing sessions without metadata continue to work (context block is just omitted).
