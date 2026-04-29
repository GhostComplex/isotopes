// src/core/tools.ts — Tool registry and execution
// Manages tool definitions and their handlers.
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolSettings, ProviderConfig, Tool } from "./types.js";
import type { HookRegistry } from "../plugins/hooks.js";
import type { FsLike } from "../sandbox/fs-bridge.js";
import { createWebFetchTool, createWebSearchTool } from "../tools/web.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { SUBAGENT_AGENT_ID, CLAUDE_AGENT_ID, SendMessageValidationError } from "../agents/runtime.js";
import type { SendMessageRequest } from "../agents/types.js";
import { getMessageContext } from "../transport/context.js";
import { getDiscordSubagentStreamContext } from "../plugins/discord/subagent-stream-context.js";
import { DiscordSubagentSink } from "../plugins/discord/discord-subagent-sink.js";
import { failureTracker } from "../agents/failure-tracker.js";
import { getAgentEndMeta } from "../../agent/runners/pi/messages.js";
import { createLogger } from "../../logging/logger.js";
const log = createLogger("tools:send-message");
/** Function that executes a tool call and returns a string result. */
export type ToolHandler = (args: unknown) => Promise<string>;
/** A registered tool entry pairing a schema with its execution handler. */
export interface ToolEntry {
  tool: Tool;
  handler: ToolHandler;
}
/**
 * ToolRegistry — manages tool definitions and handlers.
 *
 * Tools are registered with a schema (for LLM) and a handler (for execution).
 * The registry validates and executes tool calls from the agent.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();
  private hooks?: HookRegistry;
  private readonly agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  setHooks(hooks: HookRegistry): void {
    this.hooks = hooks;
  }
  /**
   * Register a tool with its handler.
   * @throws if tool name already registered
   */
  register(tool: Tool, handler: ToolHandler): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, { tool, handler });
  }
  /**
   * Get a registered tool entry.
   */
  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }
  /**
   * List all registered tool schemas (for LLM).
   */
  list(): Tool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }
  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }
  /**
   * Execute a tool by name.
   * @returns Tool output as string
   * @throws if tool not found or handler throws
   */
  async execute(name: string, args: unknown): Promise<string> {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new Error(`Tool "${name}" not found`);
    }
    const agentId = this.agentId;
    if (this.hooks) {
      await this.hooks.emit("before_tool_call", { agentId, toolName: name, args });
    }
    const result = await entry.handler(args);
    if (this.hooks) {
      await this.hooks.emit("after_tool_call", { agentId, toolName: name, args, result });
    }
    return result;
  }
  /**
   * Unregister a tool.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }
  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
  }
}
// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------
/**
 * Create a simple echo tool (useful for testing).
 */
export function createEchoTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "echo",
      description: "Echoes the input message back",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to echo",
          },
        },
        required: ["message"],
      },
    },
    handler: async (args) => {
      const { message } = args as { message: string };
      return message;
    },
  };
}
/**
 * Create a current time tool.
 */
export function createTimeTool(): { tool: Tool; handler: ToolHandler } {
  return {
    tool: {
      name: "get_current_time",
      description: "Returns the current date and time",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "IANA timezone (e.g., 'Asia/Shanghai'). Defaults to UTC.",
          },
        },
      },
    },
    handler: async (args) => {
      const { timezone } = (args as { timezone?: string }) || {};
      const now = new Date();
      if (timezone) {
        try {
          return now.toLocaleString("en-US", { timeZone: timezone });
        } catch {
          return `Invalid timezone: ${timezone}. Current UTC: ${now.toISOString()}`;
        }
      }
      return now.toISOString();
    },
  };
}
// ---------- send_message tool ----------

// Re-exported from src/agents/runtime.ts for back-compat import paths.
export { SUBAGENT_AGENT_ID, CLAUDE_AGENT_ID };

export interface SendMessageToolOptions {
  /** Unified runtime — the tool calls runtime.sendMessage to deliver. */
  runtime: AgentRuntime;
  /** Caller's agent id; recorded as `from.agentId` on the request. */
  parentAgentId: string;
  /** Caller's workspace path; default cwd when target is leaf and no
   * `working_directory` is supplied. */
  workspacePath: string;
  /** Caller's provider — needed when targeting the "subagent" magic id. */
  parentProvider?: ProviderConfig;
  /** Caller's tool registry — filtered and lent to leaf sessions. */
  parentTools?: ToolRegistry;
  /** Optional explicit allow-list of target ids. Defaults to runtime registry + magic ids. */
  allowedAgents?: string[];
  /** Pre-computed list of registered agent ids (avoids depending on init order). */
  spawnableAgentIds?: string[];
}

export function createSendMessageTool(options: SendMessageToolOptions): { tool: Tool; handler: ToolHandler } {
  const { runtime, parentAgentId, workspacePath, parentProvider, parentTools, allowedAgents, spawnableAgentIds } = options;
  const computedTargets: string[] = [];
  if (parentProvider && parentTools) computedTargets.push(SUBAGENT_AGENT_ID);
  if (runtime.hasClaudeRunner()) computedTargets.push(CLAUDE_AGENT_ID);
  if (spawnableAgentIds) {
    for (const id of spawnableAgentIds) {
      if (id !== parentAgentId && !computedTargets.includes(id)) computedTargets.push(id);
    }
  }
  const targets = allowedAgents ?? computedTargets;

  return {
    tool: {
      name: "send_message",
      description:
        `Send a message to another agent. Available targets: ${targets.join(", ") || "(none)"}. ` +
        "For `subagent`, an ephemeral helper runs with your filtered tool set and returns its " +
        "final assistant message as the result. For `claude`, a Claude CLI session runs against " +
        "`working_directory` and returns its final assistant message. For a registered agent id, " +
        "the message is appended to that agent's session as a user-role turn and its reply is returned.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: `Target agent id. Options: ${targets.join(", ")}.`,
            enum: targets,
          },
          content: {
            type: "string",
            description: "Message content to deliver as the user-role turn.",
          },
          working_directory: {
            type: "string",
            description:
              "Working directory for the target's session (relative to your workspace or absolute). " +
              "Required for `claude`; optional for others (defaults to your workspace root).",
          },
          conversation_id: {
            type: "string",
            description:
              "Optional existing session id to resume. Only valid for registered agents " +
              "(not `subagent` or `claude`).",
          },
        },
        required: ["to", "content"],
      },
    },
    handler: async (args) => {
      const { to, content, working_directory, conversation_id } = args as {
        to: string;
        content: string;
        working_directory?: string;
        conversation_id?: string;
      };
      if (!targets.includes(to)) {
        return `[error] Unknown target: ${to}. Available: ${targets.join(", ")}`;
      }
      const isSubagent = to === SUBAGENT_AGENT_ID;
      const isClaude = to === CLAUDE_AGENT_ID;
      const cwd = working_directory
        ? path.resolve(workspacePath, working_directory)
        : workspacePath;
      const ctx = getMessageContext();
      const callerSessionId = ctx?.parentSessionId;

      // failureTracker keyed on (parentSessionId, content) — block runaway loops.
      if (callerSessionId) {
        const block = failureTracker.shouldBlock(callerSessionId, content);
        if (block.blocked) {
          log.warn("send_message blocked", { from: parentAgentId, to, reason: block.reason });
          return `[blocked] ${block.reason}`;
        }
        failureTracker.recordSpawn(callerSessionId);
      }

      let cancelReason: string | undefined;
      const req: SendMessageRequest = {
        to,
        content,
        cwd,
        from: { agentId: parentAgentId },
        ...(conversation_id ? { sessionId: conversation_id } : {}),
        ...(ctx?.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
        ...(isSubagent && parentProvider && parentTools
          ? { leafContext: { provider: parentProvider, tools: parentTools } }
          : {}),
        onCancel: (reason) => { cancelReason = reason; },
      };
      log.info("send_message", { from: parentAgentId, to, cwd, hasConversation: !!conversation_id, parent: ctx?.parentSessionId });

      // Sub-run thread streaming when invoked from inside a Discord chat.
      const discordCtx = getDiscordSubagentStreamContext();
      let sink: DiscordSubagentSink | undefined;
      const startedAt = Date.now();
      const taskLabel = `${to}: ${content.slice(0, 80)}${content.length > 80 ? "…" : ""}`;

      req.onRunStart = (runId: string) => {
        if (discordCtx) {
          const showToolCalls = discordCtx.showToolCalls ?? true;
          sink = new DiscordSubagentSink(discordCtx, runId, { showToolCalls });
          void sink.start(taskLabel); // async; don't block the run
        }
      };

      let assistantText = "";
      let errorMessage: string | null = null;
      try {
        for await (const event of runtime.sendMessage(req)) {
          if (sink) await sink.sendEvent(event);
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") assistantText += ame.delta;
          } else if (event.type === "agent_end") {
            const meta = getAgentEndMeta(event.messages);
            if (meta.stopReason === "error") {
              errorMessage = meta.errorMessage ?? "Unknown agent error";
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Validation errors → [error] (LLM shouldn't retry, no failureTracker hit).
        if (err instanceof SendMessageValidationError) {
          if (sink) {
            await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
          }
          return `[error] ${msg}`;
        }
        if (sink) {
          await sink.finish({ success: false, error: msg, durationMs: Date.now() - startedAt });
        }
        if (callerSessionId) failureTracker.recordFailure(callerSessionId, content, msg);
        return `[send_message failed] ${msg}`;
      }

      // User cancel → distinct result so LLM doesn't retry; recordCancel
      // also blocks any one-shot retry at the next sendMessage entry.
      if (cancelReason === "user") {
        if (callerSessionId) failureTracker.recordCancel(callerSessionId, content);
        if (sink) {
          await sink.finish({ success: false, error: "cancelled by user", durationMs: Date.now() - startedAt });
        }
        return `[send_message cancelled by user — do not retry this same request]`;
      }

      if (sink) {
        await sink.finish({
          success: !errorMessage,
          ...(assistantText.trim() ? { output: assistantText.trim() } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
          durationMs: Date.now() - startedAt,
        });
      }
      if (errorMessage) {
        if (callerSessionId) failureTracker.recordFailure(callerSessionId, content, errorMessage);
        return `[send_message failed] ${errorMessage}`;
      }
      const trimmed = assistantText.trim();
      return trimmed.length > 0 ? trimmed : (isClaude ? "[claude completed with no output]" : "[no reply]");
    },
  };
}
// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------
export interface FileToolOptions {
  /** Workspace directory — relative paths resolve against this */
  workspacePath?: string;
  /** Maximum file size to read in bytes (default: 1MB) */
  maxReadSize?: number;
  /**
   * Filesystem implementation. Defaults to node:fs/promises (host fs).
   * cli.ts injects a SandboxFs instance instead when the agent runs sandboxed,
   * so tool handlers themselves never branch on host vs. sandbox.
   */
  fsImpl?: FsLike;
}

function resolveFilePath(targetPath: string, workspacePath?: string): string {
  if (path.isAbsolute(targetPath)) return path.resolve(targetPath);
  return workspacePath ? path.resolve(workspacePath, targetPath) : path.resolve(targetPath);
}

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".tif",
]);

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_READ_SIZE = 50 * 1024; // 50 KB for text files

/**
 * Create a file read tool.
 *
 * Supports text files (with optional offset/limit for pagination) and image
 * files (returned as base64-encoded strings). Text files are truncated at
 * `maxLines` (default 2000) when neither offset nor limit is specified.
 */
export function createReadFileTool(options: FileToolOptions = {}): { tool: Tool; handler: ToolHandler } {
  const {
    workspacePath,
    maxReadSize = DEFAULT_MAX_READ_SIZE,
    fsImpl = fs,
  } = options;
  return {
    tool: {
      name: "read_file",
      description:
        "Read the contents of a file. Returns text content (with optional line offset/limit for large files) or base64-encoded data for image files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read (relative to workspace or absolute)",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (0-based). Only applies to text files.",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to return. Only applies to text files.",
          },
        },
        required: ["path"],
      },
    },
    handler: async (args) => {
      const { path: filePath, offset, limit } = args as {
        path: string;
        offset?: number;
        limit?: number;
      };
      try {
        const resolvedPath = resolveFilePath(filePath, workspacePath);
        const stats = await fsImpl.stat(resolvedPath);

        // Image files — return base64
        const ext = path.extname(resolvedPath).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          const buf = await fsImpl.readFile(resolvedPath);
          const mimeType = ext === ".svg" ? "image/svg+xml" : `image/${ext.slice(1).replace("jpg", "jpeg")}`;
          return JSON.stringify({
            type: "image",
            encoding: "base64",
            mime_type: mimeType,
            data: buf.toString("base64"),
          });
        }

        // Text files
        if (stats.size > maxReadSize && offset == null && limit == null) {
          return `[error] File too large (${stats.size} bytes, max ${maxReadSize}). Use offset and limit to read in chunks.`;
        }
        const content = await fsImpl.readFile(resolvedPath, "utf-8");
        const allLines = content.split("\n");
        const totalLines = allLines.length;

        const startLine = offset ?? 0;
        const maxLines = limit ?? DEFAULT_MAX_LINES;
        const selectedLines = allLines.slice(startLine, startLine + maxLines);
        const truncated = startLine + maxLines < totalLines;

        if (offset != null || limit != null || truncated) {
          const result = selectedLines.join("\n");
          const meta = `[lines ${startLine + 1}-${startLine + selectedLines.length} of ${totalLines}]`;
          return truncated ? `${meta}\n${result}\n[truncated]` : `${meta}\n${result}`;
        }

        return content;
      } catch (error) {
        const err = error as { code?: string; message?: string };
        if (err.code === "ENOENT") {
          return `[error] File not found: ${filePath}`;
        }
        return `[error] ${err.message || String(error)}`;
      }
    },
  };
}
/**
 * Create a file write tool.
 */
export function createWriteFileTool(options: FileToolOptions = {}): { tool: Tool; handler: ToolHandler } {
  const { workspacePath, fsImpl = fs } = options;
  return {
    tool: {
      name: "write_file",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to write (relative to workspace or absolute)",
          },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
    handler: async (args) => {
      const { path: filePath, content } = args as { path: string; content: string };
      try {
        const resolvedPath = resolveFilePath(filePath, workspacePath);
        const parentDir = path.dirname(resolvedPath);
        await fsImpl.mkdir(parentDir, { recursive: true });
        await fsImpl.writeFile(resolvedPath, content, "utf-8");
        return `Successfully wrote ${content.length} bytes to ${filePath}`;
      } catch (error) {
        const err = error as { message?: string };
        return `[error] ${err.message || String(error)}`;
      }
    },
  };
}
/**
 * Create a directory listing tool.
 */
export function createListDirTool(options: FileToolOptions = {}): { tool: Tool; handler: ToolHandler } {
  const { workspacePath, fsImpl = fs } = options;
  return {
    tool: {
      name: "list_dir",
      description: "List files and directories in a path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (relative to workspace or absolute). Defaults to current directory.",
          },
        },
      },
    },
    handler: async (args) => {
      const { path: dirPath = "." } = args as { path?: string };
      try {
        const resolvedPath = resolveFilePath(dirPath, workspacePath);
        const entries = await fsImpl.readdir(resolvedPath, { withFileTypes: true });
        const lines = entries.map((entry) => {
          const prefix = entry.isDirectory() ? "[dir] " : "      ";
          return `${prefix}${entry.name}`;
        });
        return lines.length > 0 ? lines.join("\n") : "(empty directory)";
      } catch (error) {
        const err = error as { code?: string; message?: string };
        if (err.code === "ENOENT") {
          return `[error] Directory not found: ${dirPath}`;
        }
        return `[error] ${err.message || String(error)}`;
      }
    },
  };
}
/**
 * Create a file edit tool (search & replace).
 */
export function createEditFileTool(options: FileToolOptions = {}): { tool: Tool; handler: ToolHandler } {
  const { workspacePath, fsImpl = fs } = options;
  return {
    tool: {
      name: "edit",
      description:
        "Edit a file by replacing exact text matches. Safer than rewriting the entire file — only the matched portions are modified. By default old_text must appear exactly once; use expected_count to allow replacing a specific number of occurrences.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit (relative to workspace or absolute)",
          },
          old_text: {
            type: "string",
            description: "Exact text to search for in the file",
          },
          new_text: {
            type: "string",
            description: "Replacement text",
          },
          expected_count: {
            type: "number",
            description: "Expected number of matches. If provided, the actual match count must equal this value or the edit is rejected. If omitted, old_text must appear exactly once.",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
    handler: async (args) => {
      const { path: filePath, old_text, new_text, expected_count } = args as {
        path: string;
        old_text: string;
        new_text: string;
        expected_count?: number;
      };
      try {
        if (!old_text) {
          return "[error] old_text must not be empty";
        }
        const resolvedPath = resolveFilePath(filePath, workspacePath);
        const content = await fsImpl.readFile(resolvedPath, "utf-8");
        // Count occurrences
        let matches = 0;
        let searchFrom = 0;
        while (true) {
          const idx = content.indexOf(old_text, searchFrom);
          if (idx === -1) break;
          matches++;
          searchFrom = idx + old_text.length;
        }
        if (matches === 0) {
          return `[error] old_text not found in ${filePath}`;
        }
        if (expected_count !== undefined) {
          if (matches !== expected_count) {
            return `[error] Expected ${expected_count} matches but found ${matches} in ${filePath}`;
          }
        } else if (matches > 1) {
          return `[error] old_text found ${matches} times in ${filePath} — provide expected_count to replace multiple occurrences, or be more specific`;
        }
        if (old_text === new_text) {
          return JSON.stringify({ success: true, matches });
        }
        const updated = content.split(old_text).join(new_text);
        await fsImpl.writeFile(resolvedPath, updated, "utf-8");
        return JSON.stringify({ success: true, matches });
      } catch (error) {
        const err = error as { code?: string; message?: string };
        if (err.code === "ENOENT") {
          return `[error] File not found: ${filePath}`;
        }
        return `[error] ${err.message || String(error)}`;
      }
    },
  };
}
export function buildToolGuardPrompt(
  tools: Tool[],
  workspacePath: string,
): string {
  const lines = [
    "# Tooling",
    "Only the following tools are available in this runtime:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    "",
    `Workspace path: ${workspacePath}`,
  ];
  return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Tool policy — per-agent allow/deny filtering
// ---------------------------------------------------------------------------

/**
 * Apply tool policy (allow/deny lists) to a set of tool entries.
 *
 * - If `allow` is set, only tools in the allow list pass through.
 * - If `deny` is set, those tools are removed.
 * - `deny` takes precedence over `allow` (a tool in both lists is denied).
 */
export function applyToolPolicy(
  tools: { tool: Tool; handler: ToolHandler }[],
  policy?: { allow?: string[]; deny?: string[] },
): { tool: Tool; handler: ToolHandler }[] {
  if (!policy) return tools;
  const { allow, deny } = policy;
  if (!allow && !deny) return tools;

  const denySet = deny ? new Set(deny) : undefined;
  const allowSet = allow ? new Set(allow) : undefined;

  return tools.filter(({ tool }) => {
    // deny takes precedence
    if (denySet?.has(tool.name)) return false;
    // if allow is set, tool must be in the allow list
    if (allowSet && !allowSet.has(tool.name)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tool set helpers
// ---------------------------------------------------------------------------
/**
 * Create a standard set of tools for an agent workspace.
 */
/** Tools that modify files - excluded when codingMode is 'send-message' */
export const FILE_WRITING_TOOLS = ["write_file", "edit"];

export interface CreateWorkspaceToolsOptions {
  workspacePath: string;
  settings?: AgentToolSettings;
  /** Register the `send_message` tool. Requires `runtime` + `parentAgentId`. */
  sendMessageEnabled?: boolean;
  /** "send-message" excludes write_file/edit (caller delegates code edits). */
  codingMode?: "send-message" | "direct" | "auto";
  fsImpl?: FsLike;
  parentAgentId?: string;
  /** Caller's provider — needed when targeting `subagent` (lent to leaf). */
  parentProvider?: ProviderConfig;
  /** Caller's tool registry — filtered + lent to leaf sessions. */
  parentTools?: ToolRegistry;
  /** Unified runtime — required when sendMessageEnabled is true. */
  runtime?: AgentRuntime;
  /** Pre-computed list of registered agent ids the LLM can address. */
  spawnableAgentIds?: string[];
}

export function createWorkspaceToolsWithGuards(
  options: CreateWorkspaceToolsOptions,
): { tool: Tool; handler: ToolHandler }[] {
  const {
    workspacePath,
    settings,
    sendMessageEnabled = false,
    codingMode = "auto",
    fsImpl,
    parentAgentId,
    parentProvider,
    parentTools,
    runtime,
    spawnableAgentIds,
  } = options;
  const fileOpts: FileToolOptions = { workspacePath, ...(fsImpl ? { fsImpl } : {}) };
  let tools = [
    createReadFileTool(fileOpts),
    createWriteFileTool(fileOpts),
    createEditFileTool(fileOpts),
    createListDirTool(fileOpts),
    createTimeTool(),
  ];
  if (sendMessageEnabled && runtime && parentAgentId) {
    tools.push(createSendMessageTool({
      runtime,
      parentAgentId,
      workspacePath,
      ...(parentProvider ? { parentProvider } : {}),
      ...(parentTools ? { parentTools } : {}),
      ...(spawnableAgentIds ? { spawnableAgentIds } : {}),
    }));
  }
  if (settings?.web) {
    tools.push(createWebFetchTool());
    tools.push(createWebSearchTool());
  }

  if (codingMode === "send-message") {
    tools = tools.filter((t) => !FILE_WRITING_TOOLS.includes(t.tool.name));
  }

  return tools;
}
