// src/transport/index.ts — Barrel exports for the shared transport layer.

export { ChannelRegistry } from "./channel-registry.js";
export {
  composeSessionId,
  parseSessionId,
  type SessionKeyParts,
} from "./session-key-codec.js";
export {
  shouldDeliver,
  type NoMentionConfig,
  type IncomingMessage,
} from "./no-mention-filter.js";
export {
  runWithMessageContext,
  getMessageContext,
  type MessageContext,
} from "./context.js";
