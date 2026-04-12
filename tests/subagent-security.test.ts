// tests/subagent-security.test.ts — M8.4 Test Coverage for Subagent Security

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AcpxBackend, parseAcpxJsonLine } from "../src/subagent/acpx-backend.js";
import {
  initSubagentBackend,

  getActiveSubagentCount,
  getSupportedAgents,
} from "../src/tools/subagent.js";

// ---------------------------------------------------------------------------
// M8.4.1: permissionMode configuration parsing
// ---------------------------------------------------------------------------

describe("M8.4.1: permissionMode configuration", () => {
  it("defaults to 'allowlist' when not specified", () => {
    const backend = new AcpxBackend();
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    // allowlist mode with default tools should include --allowedTools
    expect(args).toContain("--allowedTools");
  });

  it("uses --dangerously-skip-permissions for 'skip' mode", () => {
    const backend = new AcpxBackend({
      permissionMode: "skip",
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
  });

  it("uses --allowedTools for 'allowlist' mode", () => {
    const backend = new AcpxBackend({
      permissionMode: "allowlist",
      allowedTools: ["Read", "Write", "Edit"],
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
    expect(args).toContain("Write");
    expect(args).toContain("Edit");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("uses no permission flags for 'default' mode", () => {
    const backend = new AcpxBackend({
      permissionMode: "default",
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
  });

  it("per-spawn options override backend defaults", () => {
    const backend = new AcpxBackend({
      permissionMode: "allowlist",
      allowedTools: ["Read"],
    });
    
    // Override with skip mode
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
      permissionMode: "skip",
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
  });
});

// ---------------------------------------------------------------------------
// M8.4.2: allowedTools filtering logic
// ---------------------------------------------------------------------------

describe("M8.4.2: allowedTools filtering", () => {
  it("uses default tools when not specified", () => {
    const backend = new AcpxBackend({
      permissionMode: "allowlist",
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    // Default tools should be included
    expect(args).toContain("Read");
    expect(args).toContain("Write");
    expect(args).toContain("Edit");
    expect(args).toContain("Glob");
    expect(args).toContain("Grep");
    expect(args).toContain("LS");
  });

  it("restricts to specified tools only", () => {
    const backend = new AcpxBackend({
      permissionMode: "allowlist",
      allowedTools: ["Read", "LS"],
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    expect(args).toContain("Read");
    expect(args).toContain("LS");
    // Other default tools should NOT be included
    const toolsStartIdx = args.indexOf("--allowedTools") + 1;
    const remainingArgs = args.slice(toolsStartIdx);
    // Count how many tools are passed
    const toolCount = remainingArgs.filter(arg => !arg.startsWith("-")).length;
    expect(toolCount).toBe(2);
  });

  it("empty allowedTools falls back to default behavior", () => {
    const backend = new AcpxBackend({
      permissionMode: "allowlist",
      allowedTools: [],
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
    });
    // Empty list means no --allowedTools flag
    expect(args).not.toContain("--allowedTools");
  });

  it("per-spawn allowedTools override backend defaults", () => {
    const backend = new AcpxBackend({
      permissionMode: "allowlist",
      allowedTools: ["Read", "Write"],
    });
    const args = backend.buildLegacyArgs({
      agent: "claude",
      prompt: "test",
      cwd: "/tmp",
      allowedTools: ["Glob", "Grep"],
    });
    expect(args).toContain("Glob");
    expect(args).toContain("Grep");
    expect(args).not.toContain("Read");
    expect(args).not.toContain("Write");
  });
});

// ---------------------------------------------------------------------------
// M8.4.3: workspacesKey singleton comparison
// ---------------------------------------------------------------------------

describe("M8.4.3: workspacesKey singleton", () => {
  it("generates consistent key for same workspaces", () => {
    const backend1 = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/project1", "/home/user/project2"],
    });
    const backend2 = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/project1", "/home/user/project2"],
    });
    expect(backend1.workspacesKey).toBe(backend2.workspacesKey);
  });

  it("generates same key regardless of workspace order", () => {
    const backend1 = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/a", "/home/user/b", "/home/user/c"],
    });
    const backend2 = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/c", "/home/user/a", "/home/user/b"],
    });
    expect(backend1.workspacesKey).toBe(backend2.workspacesKey);
  });

  it("generates different key for different workspaces", () => {
    const backend1 = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/project1"],
    });
    const backend2 = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/project2"],
    });
    expect(backend1.workspacesKey).not.toBe(backend2.workspacesKey);
  });

  it("generates empty key for no workspaces", () => {
    const backend = new AcpxBackend();
    expect(backend.workspacesKey).toBe("");
  });

  it("generates empty key for undefined workspaces", () => {
    const backend = new AcpxBackend({});
    expect(backend.workspacesKey).toBe("");
  });

  it("key format uses colon separator", () => {
    const backend = new AcpxBackend({
      allowedWorkspaceRoots: ["/a", "/b"],
    });
    expect(backend.workspacesKey).toBe("/a:/b");
  });
});

// ---------------------------------------------------------------------------
// M8.4.4: validateCwd path validation
// ---------------------------------------------------------------------------

describe("M8.4.4: validateCwd path validation", () => {
  let testDir: string;
  let subDir: string;
  let outsideDir: string;

  beforeEach(() => {
    // Create temp directories for testing
    testDir = mkdtempSync(join(tmpdir(), "isotopes-test-"));
    subDir = join(testDir, "subdir");
    outsideDir = mkdtempSync(join(tmpdir(), "isotopes-outside-"));
    mkdirSync(subDir);
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    if (existsSync(outsideDir)) rmSync(outsideDir, { recursive: true });
  });

  it("allows cwd within allowed workspace", () => {
    const backend = new AcpxBackend({
      allowedWorkspaceRoots: [testDir],
    });
    // Should not throw
    expect(() => backend.validateCwd(subDir)).not.toThrow();
  });

  it("allows exact workspace root as cwd", () => {
    const backend = new AcpxBackend({
      allowedWorkspaceRoots: [testDir],
    });
    expect(() => backend.validateCwd(testDir)).not.toThrow();
  });

  it("rejects cwd outside allowed workspaces", () => {
    const backend = new AcpxBackend({
      allowedWorkspaceRoots: [testDir],
    });
    expect(() => backend.validateCwd(outsideDir)).toThrow(/outside allowed workspaces/);
  });

  it("rejects non-existent directory", () => {
    const backend = new AcpxBackend();
    expect(() => backend.validateCwd("/nonexistent/path/xyz123")).toThrow(/does not exist/);
  });

  it("rejects file path (not directory)", () => {
    const backend = new AcpxBackend();
    // /etc/passwd is a file, not a directory
    expect(() => backend.validateCwd("/etc/passwd")).toThrow(/is not a directory/);
  });

  it("allows any directory when no workspaces configured", () => {
    const backend = new AcpxBackend();
    // /tmp should be allowed when no restrictions
    expect(() => backend.validateCwd(tmpdir())).not.toThrow();
  });

  it("resolves symlinks to prevent escape attacks (M8.3)", () => {
    // Create symlink pointing outside allowed workspace
    const symlinkPath = join(testDir, "escape-link");
    symlinkSync(outsideDir, symlinkPath);

    const backend = new AcpxBackend({
      allowedWorkspaceRoots: [testDir],
    });

    // Symlink is inside testDir, but resolves to outsideDir
    // Should be rejected because real path is outside allowed workspaces
    expect(() => backend.validateCwd(symlinkPath)).toThrow(/outside allowed workspaces/);
  });
});

// ---------------------------------------------------------------------------
// M8.4.5: Agent validation
// ---------------------------------------------------------------------------

describe("M8.4.5: Agent validation", () => {
  it("accepts valid agent names", () => {
    const backend = new AcpxBackend();
    const validAgents = ["claude", "codex", "gemini", "cursor", "copilot", "opencode", "kimi", "qwen"];
    
    for (const agent of validAgents) {
      expect(() => backend.validateAgent(agent)).not.toThrow();
    }
  });

  it("rejects unknown agent names", () => {
    const backend = new AcpxBackend();
    expect(() => backend.validateAgent("unknown-agent")).toThrow(/Unknown agent/);
    expect(() => backend.validateAgent("gpt4")).toThrow(/Unknown agent/);
    expect(() => backend.validateAgent("")).toThrow(/Unknown agent/);
  });

  it("getSupportedAgents returns all valid agents", () => {
    const agents = getSupportedAgents();
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
    expect(agents).toContain("gemini");
    expect(agents.length).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// M8.4.6: initSubagentBackend configuration
// ---------------------------------------------------------------------------

describe("M8.4.6: initSubagentBackend", () => {
  it("initializes with custom config", () => {
    // This should not throw
    expect(() => {
      initSubagentBackend({
        permissionMode: "skip",
        allowedTools: ["Read"],
      });
    }).not.toThrow();
  });

  it("initializes with empty config", () => {
    expect(() => {
      initSubagentBackend({});
    }).not.toThrow();
  });

  it("getActiveSubagentCount returns 0 initially", () => {
    initSubagentBackend({});
    expect(getActiveSubagentCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M8.4.7: Legacy constructor compatibility
// ---------------------------------------------------------------------------

describe("M8.4.7: Legacy constructor compatibility", () => {
  it("accepts array of workspace roots (legacy signature)", () => {
    const backend = new AcpxBackend(["/home/user/project"]);
    expect(backend.workspacesKey).toBe("/home/user/project");
  });

  it("accepts undefined (legacy signature)", () => {
    const backend = new AcpxBackend(undefined);
    expect(backend.workspacesKey).toBe("");
  });

  it("accepts options object (new signature)", () => {
    const backend = new AcpxBackend({
      allowedWorkspaceRoots: ["/home/user/project"],
      permissionMode: "skip",
    });
    expect(backend.workspacesKey).toBe("/home/user/project");
  });
});

// ---------------------------------------------------------------------------
// parseAcpxJsonLine
// ---------------------------------------------------------------------------

describe("parseAcpxJsonLine", () => {
  it("parses agent_message_chunk → message event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }
      }
    });
    const event = parseAcpxJsonLine(line);
    expect(event).toEqual({ type: "message", content: "hello" });
  });

  it("parses tool_call pending → tool_use event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          status: "pending",
          _meta: { claudeCode: { toolName: "Bash" } },
          toolCallId: "t1",
          rawInput: { command: "ls" }
        }
      }
    });
    const event = parseAcpxJsonLine(line);
    expect(event).toEqual({ type: "tool_use", toolName: "Bash", toolInput: { command: "ls" } });
  });

  it("parses tool_call_update completed → tool_result event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          status: "completed",
          _meta: { claudeCode: { toolName: "Bash" } },
          rawOutput: "file1\nfile2"
        }
      }
    });
    const event = parseAcpxJsonLine(line);
    expect(event).toEqual({ type: "tool_result", toolName: "Bash", toolResult: "file1\nfile2" });
  });

  it("parses final result → done event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "end_turn", usage: { tokensIn: 100, tokensOut: 50 } }
    });
    const event = parseAcpxJsonLine(line);
    expect(event).toEqual({ type: "done", exitCode: 0 });
  });

  it("ignores non-session/update notifications", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/new", params: {} });
    expect(parseAcpxJsonLine(line)).toBeUndefined();
  });

  it("handles malformed JSON gracefully", () => {
    expect(parseAcpxJsonLine("{invalid")).toBeUndefined();
    expect(parseAcpxJsonLine("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildAcpxArgs
// ---------------------------------------------------------------------------

describe("buildAcpxArgs", () => {
  it("returns correct structure with defaults", () => {
    const backend = new AcpxBackend({ permissionMode: "skip" });
    const result = backend.buildAcpxArgs({ agent: "claude", prompt: "test", cwd: "/tmp" });
    expect(result.preAgentArgs).toContain("--cwd");
    expect(result.preAgentArgs).toContain("--format");
    expect(result.preAgentArgs).toContain("json");
    expect(result.preAgentArgs).toContain("--approve-all");
    expect(result.postAgentArgs).toEqual(["exec", "--file", "-"]);
  });

  it("includes model flag when specified", () => {
    const backend = new AcpxBackend({ permissionMode: "skip" });
    const result = backend.buildAcpxArgs({ agent: "claude", prompt: "test", cwd: "/tmp", model: "claude-opus" });
    expect(result.postAgentArgs).toContain("--model");
    expect(result.postAgentArgs).toContain("claude-opus");
  });

  it("includes max-turns flag when specified", () => {
    const backend = new AcpxBackend({ permissionMode: "skip" });
    const result = backend.buildAcpxArgs({ agent: "claude", prompt: "test", cwd: "/tmp", maxTurns: 10 });
    expect(result.postAgentArgs).toContain("--max-turns");
    expect(result.postAgentArgs).toContain("10");
  });

  it("skips --approve-all for non-skip permission modes", () => {
    const backend = new AcpxBackend({ permissionMode: "allowlist" });
    const result = backend.buildAcpxArgs({ agent: "claude", prompt: "test", cwd: "/tmp" });
    expect(result.preAgentArgs).not.toContain("--approve-all");
  });

  it("includes --allowed-tools for allowlist mode", () => {
    const backend = new AcpxBackend({ permissionMode: "allowlist", allowedTools: ["Read", "Write", "Edit"] });
    const result = backend.buildAcpxArgs({ agent: "claude", prompt: "test", cwd: "/tmp" });
    expect(result.preAgentArgs).toContain("--allowed-tools");
    expect(result.preAgentArgs).toContain("Read,Write,Edit");
  });

  it("uses default permission mode when set to 'default'", () => {
    const backend = new AcpxBackend({ permissionMode: "default" });
    const result = backend.buildAcpxArgs({ agent: "claude", prompt: "test", cwd: "/tmp" });
    expect(result.preAgentArgs).not.toContain("--approve-all");
    expect(result.preAgentArgs).not.toContain("--allowed-tools");
  });
});
