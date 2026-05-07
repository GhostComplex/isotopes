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

export interface CommandCallbacks {
  onNewChat: () => void;
  onExit: () => void;
  onShowStatus: () => void;
  onShowSessions: () => void;
  onHelp: () => void;
}

export function dispatch(
  command: string,
  args: string,
  callbacks: CommandCallbacks,
): boolean {
  switch (command) {
    case "new":
      callbacks.onNewChat();
      return true;
    case "exit":
    case "quit":
    case "q":
      callbacks.onExit();
      return true;
    case "status":
      callbacks.onShowStatus();
      return true;
    case "sessions":
    case "s":
      callbacks.onShowSessions();
      return true;
    case "help":
      callbacks.onHelp();
      return true;
    default:
      return false;
  }
}

export const HELP_TEXT = [
  "/new          — Start a new conversation",
  "/sessions /s  — Browse and attach to any session",
  "/status       — Show daemon status",
  "/help         — Show this help",
  "/exit /quit /q — Quit the TUI",
].join("\n");
