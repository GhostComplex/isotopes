// src/commands/slash-commands.ts — Slash command handler for admin operations
// Parses and dispatches /status, /reload, /model commands from chat messages.

import type { AgentManager, SessionStore } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("commands");

/** Parsed slash command */
export interface ParsedCommand {
  name: string;
  args: string;
}

/** Context passed to command handlers */
export interface CommandContext {
  agentManager: AgentManager;
  sessionStore: SessionStore;
  /** The agent ID this message was routed to */
  agentId: string;
  /** Discord user ID of the invoker */
  userId: string;
  /** Discord username of the invoker */
  username: string;
}

/** Result of executing a slash command */
export interface CommandResult {
  /** Response text to send back */
  response: string;
}

/**
 * SlashCommandHandler — parses and dispatches slash commands.
 *
 * Commands are prefixed with `/` or `!`. Only users in the `adminUsers`
 * list are allowed to execute commands.
 */
export class SlashCommandHandler {
  private adminUsers: Set<string>;
  private startTime: number;

  constructor(adminUsers: string[] = []) {
    this.adminUsers = new Set(adminUsers);
    this.startTime = Date.now();
  }

  /**
   * Check if a message is a slash command.
   * Returns true for messages starting with `/` or `!` followed by a known command.
   */
  isCommand(content: string): boolean {
    const parsed = this.parse(content);
    if (!parsed) return false;
    return KNOWN_COMMANDS.has(parsed.name);
  }

  /**
   * Parse a slash command from message content.
   * Returns null if the content is not a valid command.
   */
  parse(content: string): ParsedCommand | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) return null;

    // Strip the prefix
    const withoutPrefix = trimmed.slice(1);
    const spaceIdx = withoutPrefix.indexOf(" ");

    const name = spaceIdx === -1
      ? withoutPrefix.toLowerCase()
      : withoutPrefix.slice(0, spaceIdx).toLowerCase();
    const args = spaceIdx === -1
      ? ""
      : withoutPrefix.slice(spaceIdx + 1).trim();

    if (!name) return null;
    return { name, args };
  }

  /**
   * Execute a slash command. Checks admin permissions before dispatch.
   */
  async execute(content: string, ctx: CommandContext): Promise<CommandResult> {
    const parsed = this.parse(content);
    if (!parsed) {
      return { response: "Invalid command." };
    }

    // Admin check
    if (!this.adminUsers.has(ctx.userId)) {
      log.warn(`Unauthorized command attempt by ${ctx.username} (${ctx.userId}): ${parsed.name}`);
      return { response: "⛔ You are not authorized to run commands." };
    }

    log.info(`Command /${parsed.name} from ${ctx.username} (${ctx.userId})`);

    switch (parsed.name) {
      case "status":
        return this.handleStatus(ctx);
      case "reload":
        return this.handleReload(ctx);
      case "model":
        return this.handleModel(ctx, parsed.args);
      default:
        return { response: `Unknown command: /${parsed.name}` };
    }
  }

  private async handleStatus(ctx: CommandContext): Promise<CommandResult> {
    const uptimeMs = Date.now() - this.startTime;
    const uptime = formatUptime(uptimeMs);

    const agents = ctx.agentManager.list();
    const sessions = await ctx.sessionStore.list();

    // Find current agent's model
    const agentConfig = agents.find((a) => a.id === ctx.agentId);
    const model = agentConfig?.provider?.model ?? "claude-opus-4.5";

    const lines = [
      "**Agent Status**",
      `• Uptime: ${uptime}`,
      `• Model: \`${model}\``,
      `• Agent: \`${ctx.agentId}\``,
      `• Agents loaded: ${agents.length}`,
      `• Active sessions: ${sessions.length}`,
    ];

    return { response: lines.join("\n") };
  }

  private async handleReload(ctx: CommandContext): Promise<CommandResult> {
    try {
      await ctx.agentManager.reloadWorkspace(ctx.agentId);
      log.info(`Workspace reloaded for agent ${ctx.agentId} by ${ctx.username}`);
      return { response: `✅ Workspace reloaded for agent \`${ctx.agentId}\`.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Reload failed for agent ${ctx.agentId}: ${msg}`);
      return { response: `❌ Reload failed: ${msg}` };
    }
  }

  private async handleModel(ctx: CommandContext, args: string): Promise<CommandResult> {
    const modelName = args.trim();
    if (!modelName) {
      // Show current model
      const agents = ctx.agentManager.list();
      const agentConfig = agents.find((a) => a.id === ctx.agentId);
      const current = agentConfig?.provider?.model ?? "claude-opus-4.5";
      return { response: `Current model: \`${current}\`` };
    }

    try {
      const agents = ctx.agentManager.list();
      const agentConfig = agents.find((a) => a.id === ctx.agentId);
      const currentProvider = agentConfig?.provider;

      await ctx.agentManager.update(ctx.agentId, {
        provider: {
          ...currentProvider,
          type: currentProvider?.type ?? "anthropic",
          model: modelName,
        },
      });

      log.info(`Model switched to ${modelName} for agent ${ctx.agentId} by ${ctx.username}`);
      return { response: `✅ Model switched to \`${modelName}\` for agent \`${ctx.agentId}\`.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Model switch failed for agent ${ctx.agentId}: ${msg}`);
      return { response: `❌ Model switch failed: ${msg}` };
    }
  }
}

/** Set of known command names for isCommand() filtering */
const KNOWN_COMMANDS = new Set(["status", "reload", "model"]);

/** Format milliseconds as a human-readable uptime string */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
