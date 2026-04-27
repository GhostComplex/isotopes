// src/core/tools.ts — Tool registry and execution
// Manages tool definitions and their handlers.
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolSettings, ProviderConfig, Tool } from "./types.js";
import type { HookRegistry } from "../plugins/hooks.js";
import type { FsLike } from "../sandbox/fs-bridge.js";
import { spawnAgent, getSupportedAgents } from "../tools/spawn-agent.js";
import { createWebFetchTool, createWebSearchTool } from "../tools/web.js";
import type { RunEvent, BuiltinOptions } from "../agents/types.js";
import { getSpawnAgentContext, type SpawnAgentStreamContext } from "./spawn-agent-context.js";
import { failureTracker } from "../agents/failure-tracker.js";
import { createLogger } from "./logger.js";
import type { AgentServiceCache } from "./pi-mono.js";
const log = createLogger("tools:spawn-agent");
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
// ---------------------------------------------------------------------------
// Spawn agent tool
// ---------------------------------------------------------------------------
export interface SpawnAgentToolOptions {
  /** Workspace path for the spawned agent */
  workspacePath: string;
  /** Additional allowed workspaces (from agent config) */
  allowedWorkspaces?: string[];
  /** Allowed agents (defaults to all available) */
  allowedAgents?: string[];
  /** Agent manager — used to discover available in-process agents and to
   * resolve named-agent identity (cache, system prompt, workspace path) for
   * named-mode spawn. `get`/`getSystemPrompt`/`getWorkspacePath` are optional
   * so test fixtures can pass a minimal `{ list }` shim. */
  agentManager?: {
    list(): { id: string; spawnable?: boolean }[];
    get?(id: string): AgentServiceCache | undefined;
    getSystemPrompt?(id: string): string | undefined;
    getWorkspacePath?(id: string): string | undefined;
  };
  /** Pre-computed list of spawnable agent IDs (avoids init order issues) */
  spawnableAgentIds?: string[];
  /** Default timeout in seconds (default: 300) */
  timeout?: number;
  /** Maximum number of turns for the spawned agent (default: 50) */
  maxTurns?: number;
  /** Parent agent id, used as the owner of the persisted spawn agent run. */
  parentAgentId?: string;
  /**
   * Parent agent's provider config — forwarded to the in-process runner so
   * spawned agents reuse the parent's LLM credentials.
   */
  parentProvider?: ProviderConfig;
  /**
   * Parent agent's tool registry — forwarded to the in-process runner, which
   * filters it by role to derive the spawn agent's tool set.
   */
  parentTools?: ToolRegistry;
}
/**
 * Create a spawn agent tool.
 * Allows the agent to delegate tasks to coding agents like Claude or named in-process agents.
 *
 * When running within a Discord context (via `runWithSpawnAgentContext`), the
 * spawn agent output will be streamed to a Discord thread and a summary will be
 * posted to the main channel when complete.
 */
export function createSpawnAgentTool(options: SpawnAgentToolOptions): { tool: Tool; handler: ToolHandler } {
  const { workspacePath, allowedWorkspaces = [], allowedAgents, timeout, maxTurns, parentAgentId, parentProvider, parentTools, spawnableAgentIds, agentManager } = options;
  const availableAgents: string[] = [...getSupportedAgents()];
  if (spawnableAgentIds) {
    for (const id of spawnableAgentIds) {
      if (!availableAgents.includes(id)) {
        availableAgents.push(id);
      }
    }
  }
  const agents = allowedAgents ?? [...availableAgents];
  // Combine workspace path with additional allowed workspaces
  const allAllowedWorkspaces = [workspacePath, ...allowedWorkspaces];
  return {
    tool: {
      name: "spawn_agent",
      description: `Spawn a coding agent to execute a task. Available agents: ${agents.join(", ")}. The spawned agent runs in the workspace directory and can read/write files, execute commands, etc.`,
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task description for the spawned agent. Be specific about what you want it to do.",
          },
          agent: {
            type: "string",
            description: `Which agent to use. Options: ${agents.join(", ")}. Default: claude.`,
            enum: agents,
          },
          working_directory: {
            type: "string",
            description: "Working directory for the spawned agent (relative to workspace or absolute). Defaults to workspace root.",
          },
        },
        required: ["task"],
      },
    },
    handler: async (args) => {
      const { task, agent = "claude", working_directory } = args as {
        task: string;
        agent?: string;
        working_directory?: string;
      };
      // Validate agent
      if (!agents.includes(agent)) {
        return `[error] Unknown agent: ${agent}. Available: ${agents.join(", ")}`;
      }
      // Resolve working directory
      const cwd = working_directory
        ? path.resolve(workspacePath, working_directory)
        : workspacePath;
      // Check for Discord context
      const discordContext = getSpawnAgentContext();

      // Check failure tracker (only when sessionId available)
      const sessionId = discordContext?.sessionId;
      if (sessionId) {
        const check = failureTracker.shouldBlock(sessionId, task);
        if (check.blocked) {
          log.warn("Blocking spawn agent due to previous failures", { sessionId, reason: check.reason });
          return `[blocked] ${check.reason}`;
        }
        // Record spawn attempt for rate limiting
        failureTracker.recordSpawn(sessionId);
      }

      try {
        // Resolve spawn mode: if `agent` matches a registered named agent
        // (with full identity in agentManager), use named mode — load its
        // own system prompt, AgentServiceCache (provider+tools wired at
        // init), and workspace as cwd. Otherwise fall back to ephemeral
        // mode using the parent agent's provider/tools.
        const namedCache = agentManager?.get?.(agent);
        const namedSystemPrompt = agentManager?.getSystemPrompt?.(agent);
        const namedWorkspace = agentManager?.getWorkspacePath?.(agent);
        const isNamed = namedCache !== undefined && namedSystemPrompt !== undefined && namedSystemPrompt.length > 0;

        let builtin: BuiltinOptions | undefined;
        let targetAgentId: string | undefined;
        let effectiveCwd = cwd;
        let effectiveAllowedWorkspaces = allAllowedWorkspaces;

        if (isNamed) {
          builtin = { mode: "named", cache: namedCache, systemPrompt: namedSystemPrompt };
          targetAgentId = agent;
          if (namedWorkspace) {
            // Named agents run in their OWN workspace, not the parent's.
            // The parent cannot scope a named-agent spawn to the parent's
            // filesystem — by design, the named agent retains its full
            // identity including cwd. We append the target's workspace
            // to allowedWorkspaces so AgentRuntime.validateCwd accepts it.
            effectiveCwd = namedWorkspace;
            effectiveAllowedWorkspaces = [...allAllowedWorkspaces, namedWorkspace];
          }
          log.info("Spawning named agent", { agent, parentAgentId, cwd: effectiveCwd });
        } else if (parentProvider && parentTools) {
          builtin = { mode: "ephemeral", provider: parentProvider, tools: parentTools };
        }

        let result: string;
        if (discordContext) {
          result = await runSpawnAgentWithStreaming(task, agent, effectiveCwd, timeout, effectiveAllowedWorkspaces, discordContext, maxTurns, parentAgentId, builtin, targetAgentId);
        } else {
          result = await runSpawnAgentPlain(task, agent, effectiveCwd, timeout, effectiveAllowedWorkspaces, maxTurns, parentAgentId, builtin, targetAgentId);
        }

        // Record failure if result indicates failure
        if (sessionId && (result.includes("[spawn agent failed]") || result.includes("[error]"))) {
          failureTracker.recordFailure(sessionId, task, result);
        }

        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Record failure
        if (sessionId) {
          failureTracker.recordFailure(sessionId, task, error);
        }
        return `[error] Failed to spawn agent: ${error}`;
      }
    },
  };
}
/**
 * Run spawn agent without transport streaming.
 */
async function runSpawnAgentPlain(
  task: string,
  agent: string,
  cwd: string,
  timeout: number | undefined,
  allowedWorkspaces: string[],
  maxTurns?: number,
  parentAgentId?: string,
  builtin?: BuiltinOptions,
  targetAgentId?: string,
): Promise<string> {
  const result = await spawnAgent(task, {
    agent,
    cwd,
    timeout,
    allowedWorkspaces,
    maxTurns,
    parentAgentId,
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(builtin ? { builtin } : {}),
  });
  if (result.success) {
    return result.output ?? "[spawn agent completed with no output]";
  } else {
    return `[spawn agent failed] ${result.error ?? "unknown error"}`;
  }
}
/**
 * Run spawn agent with transport streaming.
 * Creates a sink via the stream context, streams events to it, and posts a summary.
 */
async function runSpawnAgentWithStreaming(
  task: string,
  agent: string,
  cwd: string,
  timeout: number | undefined,
  allowedWorkspaces: string[],
  context: SpawnAgentStreamContext,
  maxTurns?: number,
  parentAgentId?: string,
  builtin?: BuiltinOptions,
  targetAgentId?: string,
): Promise<string> {
  const { channelId, showToolCalls = true, onComplete } = context;
  const sink = context.createSink(channelId, { showToolCalls, useThread: true });
  const taskLabel = `${agent}: ${task.slice(0, 50)}${task.length > 50 ? "..." : ""}`;
  log.info("Starting spawn agent with streaming", { agent, cwd, channelId });
  await sink.start(taskLabel);

  const threadId = sink.getThreadId?.();
  const startTime = Date.now();
  const events: RunEvent[] = [];

  try {
    const result = await spawnAgent(task, {
      agent,
      cwd,
      timeout,
      maxTurns,
      allowedWorkspaces,
      channelId,
      threadId,
      parentAgentId,
      ...(targetAgentId ? { targetAgentId } : {}),
      ...(builtin ? { builtin } : {}),
      onEvent: async (event) => {
        events.push(event);
        await sink.sendEvent(event);
      },
    });

    const durationMs = Date.now() - startTime;
    const costUsd = events.find((e): e is Extract<RunEvent, { type: "run:done" }> => e.type === "run:done" && "costUsd" in e)?.costUsd;

    await sink.finish({
      success: result.success,
      output: result.output,
      error: result.error,
      events,
      exitCode: result.exitCode,
      durationMs,
      costUsd,
    });

    if (onComplete && threadId) {
      try {
        await onComplete(threadId);
      } catch (err) {
        log.warn("onComplete callback failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    log.info("Spawn agent with streaming completed", {
      success: result.success,
      threadId,
    });
    if (result.success) {
      const threadMention = threadId ? ` (see <#${threadId}>)` : "";
      return `[spawn agent completed]${threadMention}\n${result.output ?? "(no output)"}`;
    } else {
      return `[spawn agent failed] ${result.error ?? "unknown error"}`;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Spawn agent with streaming failed", { error });
    const errorEvent: RunEvent = { type: "run:error", error };
    events.push(errorEvent);
    await sink.sendEvent(errorEvent);
    const durationMs = Date.now() - startTime;
    await sink.finish({
      success: false,
      error,
      events,
      exitCode: 1,
      durationMs,
    });
    if (onComplete && threadId) {
      try {
        await onComplete(threadId);
      } catch (callbackErr) {
        log.warn("onComplete callback failed", { error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr) });
      }
    }
    throw err;
  }
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
/** Tools that modify files - excluded when codingMode is 'spawn-agent' */
export const FILE_WRITING_TOOLS = ["write_file", "edit"];

export function createWorkspaceToolsWithGuards(
  workspacePath: string,
  settings?: AgentToolSettings,
  spawnAgentEnabled = false,
  allowedWorkspaces: string[] = [],
  codingMode: "spawn-agent" | "direct" | "auto" = "auto",
  spawnAgentMaxTurns?: number,
  fsImpl?: FsLike,
  parentAgentId?: string,
  parentProvider?: ProviderConfig,
  parentTools?: ToolRegistry,
  agentManager?: {
    list(): { id: string; spawnable?: boolean }[];
    get?(id: string): AgentServiceCache | undefined;
    getSystemPrompt?(id: string): string | undefined;
    getWorkspacePath?(id: string): string | undefined;
  },
  spawnableAgentIds?: string[],
): { tool: Tool; handler: ToolHandler }[] {
  const fileOpts: FileToolOptions = { workspacePath, fsImpl };
  let tools = [
    createReadFileTool(fileOpts),
    createWriteFileTool(fileOpts),
    createEditFileTool(fileOpts),
    createListDirTool(fileOpts),
    createTimeTool(),
  ];
  if (spawnAgentEnabled) {
    tools.push(createSpawnAgentTool({ workspacePath, allowedWorkspaces, maxTurns: spawnAgentMaxTurns, parentAgentId, parentProvider, parentTools, spawnableAgentIds, agentManager }));
  }
  if (settings?.web) {
    tools.push(createWebFetchTool());
    tools.push(createWebSearchTool());
  }

  if (codingMode === "spawn-agent") {
    tools = tools.filter((t) => !FILE_WRITING_TOOLS.includes(t.tool.name));
  }

  return tools;
}
