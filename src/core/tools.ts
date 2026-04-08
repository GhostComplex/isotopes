// src/core/tools.ts — Tool registry and execution
// Manages tool definitions and their handlers.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolSettings, Tool } from "./types.js";

const execAsync = promisify(exec);

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
    return entry.handler(args);
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
// Shell tool
// ---------------------------------------------------------------------------

export interface ShellToolOptions {
  /** Working directory for command execution */
  cwd?: string;
  /** Maximum execution time in ms (default: 30000) */
  timeout?: number;
  /** Maximum output size in bytes (default: 100KB) */
  maxOutput?: number;
}

/**
 * Create a shell execution tool.
 */
export function createShellTool(options: ShellToolOptions = {}): { tool: Tool; handler: ToolHandler } {
  const { cwd, timeout = 30000, maxOutput = 100 * 1024 } = options;

  return {
    tool: {
      name: "shell",
      description: "Execute a shell command and return the output. Use for running programs, scripts, or system commands.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
        },
        required: ["command"],
      },
    },
    handler: async (args) => {
      const { command } = args as { command: string };

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: maxOutput,
        });

        let output = stdout;
        if (stderr) {
          output += (output ? "\n" : "") + `[stderr] ${stderr}`;
        }
        return output || "(no output)";
      } catch (error) {
        const err = error as { message?: string; code?: number; signal?: string; stderr?: string };
        if (err.signal === "SIGTERM") {
          return `[error] Command timed out after ${timeout}ms`;
        }
        return `[error] ${err.message || String(error)}${err.stderr ? `\n[stderr] ${err.stderr}` : ""}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

export interface FileToolOptions {
  /** Base directory for file operations (paths are resolved relative to this) */
  basePath?: string;
  /** Maximum file size to read in bytes (default: 1MB) */
  maxReadSize?: number;
}

export interface ResolvedToolGuards {
  cli: boolean;
  fs: {
    workspaceOnly: boolean;
  };
}

export function resolveToolGuards(settings?: AgentToolSettings): ResolvedToolGuards {
  return {
    cli: settings?.cli === true,
    fs: {
      workspaceOnly: settings?.fs?.workspaceOnly !== false,
    },
  };
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWorkspaceConstrainedPath(
  targetPath: string,
  basePath: string | undefined,
  mode: "read" | "write" | "list",
): Promise<string> {
  if (!basePath) {
    return path.resolve(targetPath);
  }

  const workspaceRoot = await fs.realpath(basePath).catch(() => path.resolve(basePath));
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceRoot, targetPath);

  if (mode === "write") {
    const parentDir = path.dirname(resolvedPath);
    await fs.mkdir(parentDir, { recursive: true });
    const realParentDir = await fs.realpath(parentDir).catch(() => path.resolve(parentDir));
    const finalPath = path.join(realParentDir, path.basename(resolvedPath));
    if (!isPathInside(workspaceRoot, finalPath)) {
      throw new Error(`Path escapes workspace: ${targetPath}`);
    }
    return finalPath;
  }

  const realTargetPath = await fs.realpath(resolvedPath).catch(() => path.resolve(resolvedPath));
  if (!isPathInside(workspaceRoot, realTargetPath)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }

  return realTargetPath;
}

/**
 * Create a file read tool.
 */
export function createReadFileTool(options: FileToolOptions = {}): { tool: Tool; handler: ToolHandler } {
  const { basePath, maxReadSize = 1024 * 1024 } = options;

  return {
    tool: {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content as text.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read (relative to workspace or absolute)",
          },
        },
        required: ["path"],
      },
    },
    handler: async (args) => {
      const { path: filePath } = args as { path: string };

      try {
        const resolvedPath = await resolveWorkspaceConstrainedPath(filePath, basePath, "read");

        const stats = await fs.stat(resolvedPath);
        if (stats.size > maxReadSize) {
          return `[error] File too large (${stats.size} bytes, max ${maxReadSize})`;
        }

        const content = await fs.readFile(resolvedPath, "utf-8");
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
  const { basePath } = options;

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
        const resolvedPath = await resolveWorkspaceConstrainedPath(filePath, basePath, "write");
        await fs.writeFile(resolvedPath, content, "utf-8");

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
  const { basePath } = options;

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
        const resolvedPath = await resolveWorkspaceConstrainedPath(dirPath, basePath, "list");

        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
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

export function buildToolGuardPrompt(
  tools: Tool[],
  guards: ResolvedToolGuards,
  workspacePath: string,
): string {
  const lines = [
    "# Tooling",
    "Only the following tools are available in this runtime:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    "",
    "# Tool Guards",
  ];

  if (guards.fs.workspaceOnly) {
    lines.push(`- File operations are restricted to the workspace: ${workspacePath}`);
    lines.push("- Do not attempt to access files outside the workspace.");
  } else {
    lines.push("- File operations may access host paths outside the workspace.");
  }

  if (guards.cli) {
    lines.push(`- Shell command execution is enabled and runs with cwd=${workspacePath}.`);
    lines.push("- Use shell only when file tools are insufficient for the task.");
  } else {
    lines.push("- Shell command execution is disabled in this runtime.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool set helpers
// ---------------------------------------------------------------------------

/**
 * Create a standard set of tools for an agent workspace.
 */
export function createWorkspaceTools(workspacePath: string): { tool: Tool; handler: ToolHandler }[] {
  return createWorkspaceToolsWithGuards(workspacePath);
}

export function createWorkspaceToolsWithGuards(
  workspacePath: string,
  settings?: AgentToolSettings,
): { tool: Tool; handler: ToolHandler }[] {
  const guards = resolveToolGuards(settings);
  const fileBasePath = guards.fs.workspaceOnly ? workspacePath : undefined;

  const tools = [
    createReadFileTool({ basePath: fileBasePath }),
    createWriteFileTool({ basePath: fileBasePath }),
    createListDirTool({ basePath: fileBasePath }),
    createTimeTool(),
  ];

  if (guards.cli) {
    tools.unshift(createShellTool({ cwd: workspacePath }));
  }

  return tools;
}
