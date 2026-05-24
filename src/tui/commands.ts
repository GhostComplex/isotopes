export type CommandAction = "new" | "exit" | "status" | "sessions" | "help";

const COMMANDS: Record<string, CommandAction> = {
  new: "new",
  exit: "exit",
  quit: "exit",
  q: "exit",
  status: "status",
  sessions: "sessions",
  help: "help",
};

export interface SlashCommand {
  command: string;
  args: string;
}

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: "" };
  }
  return {
    command: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export function resolveCommand(input: string): { action: CommandAction; args: string } | null {
  const parsed = parseSlashCommand(input);
  if (!parsed) return null;
  const action = COMMANDS[parsed.command];
  return action ? { action, args: parsed.args } : null;
}

export const HELP_TEXT = [
  "/new          — Start a new conversation",
  "/sessions     — Browse and attach to any session",
  "/status       — Show daemon status",
  "/help         — Show this help",
  "/exit /quit /q — Quit the TUI",
].join("\n");
