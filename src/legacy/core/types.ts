// src/legacy/core/types.ts — Re-export shim
//
// Types have been split across the new layered tree (#623 segment 2).
// This file re-exports them for back-compat while legacy/ callers are
// migrated. Once all importers point at the new locations, this file
// can be deleted.

// SDK re-exports (kept here for now; agent layer ultimately owns them)
export type { AgentMessage, AgentEvent } from "@mariozechner/pi-agent-core";
export type { Usage, ImageContent } from "@mariozechner/pi-ai";

// Tools
export type { Tool, AgentToolSettings } from "../../tools/types.js";

// Agent layer
export type { ProviderConfig, AgentConfig, CompactionMode, CompactionConfig } from "../../agent/types.js";

// Sessions
export type {
  Session,
  SessionMetadata,
  SessionConfig,
  SessionStoreConfig,
  SessionStore,
} from "../../sessions/types.js";

// Gateway (routing + transport contract)
export type {
  PeerKind,
  BindingPeer,
  BindingMatch,
  Binding,
  ChannelsConfig,
  Transport,
} from "../../gateway/types.js";

// Automation
export type { CronActionConfig } from "../../automation/types.js";
