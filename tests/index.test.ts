import { describe, it, expect } from "vitest";
import {
  VERSION,
  // Core implementations
  PiMonoCore,
  DefaultAgentManager,
  DefaultSessionStore,
  ToolRegistry,
  // Config
  loadConfig,
  toAgentConfig,
  // Workspace
  loadWorkspaceContext,
  buildSystemPrompt,
  // Transport
  DiscordTransport,
} from "../src/index.js";

describe("isotopes", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("exports core classes", () => {
    expect(PiMonoCore).toBeDefined();
    expect(DefaultAgentManager).toBeDefined();
    expect(DefaultSessionStore).toBeDefined();
    expect(ToolRegistry).toBeDefined();
  });

  it("exports config functions", () => {
    expect(loadConfig).toBeDefined();
    expect(toAgentConfig).toBeDefined();
  });

  it("exports workspace functions", () => {
    expect(loadWorkspaceContext).toBeDefined();
    expect(buildSystemPrompt).toBeDefined();
  });

  it("exports transport classes", () => {
    expect(DiscordTransport).toBeDefined();
  });
});
