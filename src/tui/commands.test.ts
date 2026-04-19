import { describe, it, expect, beforeEach } from "vitest";
import { parseSlashCommand, dispatch } from "./commands.js";

describe("parseSlashCommand", () => {
  it("returns null for plain text", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  it("parses command without args", () => {
    expect(parseSlashCommand("/exit")).toEqual({ command: "exit", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/agent mybot")).toEqual({ command: "agent", args: "mybot" });
  });

  it("trims whitespace", () => {
    expect(parseSlashCommand("  /help  ")).toEqual({ command: "help", args: "" });
  });

  it("lowercases command", () => {
    expect(parseSlashCommand("/EXIT")).toEqual({ command: "exit", args: "" });
  });

  it("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  it("preserves arg casing", () => {
    expect(parseSlashCommand("/agent MyBot")).toEqual({ command: "agent", args: "MyBot" });
  });
});

describe("dispatch", () => {
  const calls: string[] = [];
  const callbacks = {
    onNewChat: () => calls.push("new"),
    onSwitchAgent: (id: string) => calls.push(`agent:${id}`),
    onExit: () => calls.push("exit"),
    onShowStatus: () => calls.push("status"),
    onShowChat: () => calls.push("chat"),
    onHelp: () => calls.push("help"),
  };

  beforeEach(() => { calls.length = 0; });

  it("dispatches /new", () => {
    expect(dispatch("new", "", callbacks)).toBe(true);
    expect(calls).toEqual(["new"]);
  });

  it("dispatches /agent with args", () => {
    expect(dispatch("agent", "mybot", callbacks)).toBe(true);
    expect(calls).toEqual(["agent:mybot"]);
  });

  it("returns false for /agent without args", () => {
    expect(dispatch("agent", "", callbacks)).toBe(false);
  });

  it("dispatches /exit and aliases", () => {
    expect(dispatch("exit", "", callbacks)).toBe(true);
    expect(dispatch("quit", "", callbacks)).toBe(true);
    expect(dispatch("q", "", callbacks)).toBe(true);
    expect(calls).toEqual(["exit", "exit", "exit"]);
  });

  it("returns false for unknown command", () => {
    expect(dispatch("unknown", "", callbacks)).toBe(false);
  });
});
