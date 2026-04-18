// src/acp/types.ts — Type definitions for ACP (Agent Communication Protocol) sessions
// Defines session lifecycle, message, and configuration types for multi-agent coordination.

// ---------------------------------------------------------------------------
// ACP configuration
// ---------------------------------------------------------------------------

/** ACP session persistence configuration */
export interface AcpPersistenceConfig {
  /** Whether session persistence is enabled. Default: false */
  enabled: boolean;
  /** Directory to store persisted session data */
  dataDir: string;
  /** Session TTL in seconds. Sessions older than this are considered stale. Default: 86400 (24h) */
  ttl: number;
  /** Cleanup interval in seconds. How often to check for stale sessions. Default: 3600 (1h) */
  cleanupInterval: number;
}

/** ACP configuration (root-level `acp` section in config) */
export interface AcpConfig {
  /** Whether ACP is enabled */
  enabled: boolean;
  /** Default agent ID to use when none is specified */
  defaultAgent: string;
  /** Agent IDs allowed to participate in ACP sessions */
  allowedAgents?: string[];
  /** Session persistence configuration */
  persistence?: AcpPersistenceConfig;
}

// ---------------------------------------------------------------------------
// ACP session & messages
// ---------------------------------------------------------------------------

/** Status of an ACP session */
export type AcpSessionStatus = "active" | "idle" | "paused" | "terminated";

/** A single message in an ACP session history */
export interface AcpMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

/** An ACP session binding an agent to a conversation */
export interface AcpSession {
  /** Unique session identifier */
  id: string;
  /** Agent participating in this session */
  agentId: string;
  /** Discord thread ID if bound to a thread */
  threadId?: string;
  /** Current session status */
  status: AcpSessionStatus;
  /** When the session was created */
  createdAt: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
  /** Ordered message history for this session */
  history: AcpMessage[];
}

// ---------------------------------------------------------------------------
// Event callback
// ---------------------------------------------------------------------------

/** Events emitted during session lifecycle */
export type AcpSessionEvent = "created" | "updated" | "terminated";

/** Callback for session lifecycle events */
export type AcpSessionCallback = (session: AcpSession, event: AcpSessionEvent) => void;
