import { describe, it, expect } from "vitest";
import { parseSlashCommand, resolveCommand } from "./commands.js";

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

describe("resolveCommand", () => {
  it("resolves known commands", () => {
    expect(resolveCommand("/new")).toEqual({ action: "new", args: "" });
    expect(resolveCommand("/status")).toEqual({ action: "status", args: "" });
    expect(resolveCommand("/sessions")).toEqual({ action: "sessions", args: "" });
    expect(resolveCommand("/help")).toEqual({ action: "help", args: "" });
  });

  it("resolves exit aliases", () => {
    expect(resolveCommand("/exit")).toEqual({ action: "exit", args: "" });
    expect(resolveCommand("/quit")).toEqual({ action: "exit", args: "" });
    expect(resolveCommand("/q")).toEqual({ action: "exit", args: "" });
  });

  it("returns null for unknown commands", () => {
    expect(resolveCommand("/unknown")).toBeNull();
  });

  it("returns null for non-slash input", () => {
    expect(resolveCommand("hello")).toBeNull();
  });
});
