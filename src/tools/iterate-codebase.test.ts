// src/tools/iterate-codebase.test.ts — Tests for createIterateCodebaseTool

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IterationStep } from "../iteration/types.js";
import type { PipelineResult } from "../iteration/pipeline.js";

// ---------------------------------------------------------------------------
// Mocks — must be before imports that use them
// ---------------------------------------------------------------------------

// Track the pipeline instance and its mock for assertions
let mockRunSingleStep: ReturnType<typeof vi.fn>;
let capturedConstructorArgs: {
  planner: unknown;
  executor: unknown;
  reporter: unknown;
  repoPath: unknown;
};

vi.mock("../iteration/pipeline.js", () => {
  return {
    IterationPipeline: vi.fn().mockImplementation(
      (
        planner: unknown,
        executor: unknown,
        reporter: unknown,
        repoPath: unknown,
      ) => {
        capturedConstructorArgs = { planner, executor, reporter, repoPath };
        return { runSingleStep: mockRunSingleStep };
      },
    ),
  };
});

vi.mock("../iteration/planner.js", () => ({
  IterationPlanner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../iteration/executor.js", () => ({
  IterationExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../iteration/reporter.js", () => ({
  IterationReporter: vi.fn().mockImplementation(() => ({})),
}));

const mockGetSubagentBackend = vi.fn();
vi.mock("./subagent.js", () => ({
  getSubagentBackend: (...args: unknown[]) => mockGetSubagentBackend(...args),
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  createIterateCodebaseTool,
  ITERATE_CODEBASE_TOOL,
} from "./iterate-codebase.js";
import { IterationPlanner } from "../iteration/planner.js";
import { IterationExecutor } from "../iteration/executor.js";

import { IterationPipeline } from "../iteration/pipeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<IterationStep> = {}): IterationStep {
  return {
    id: "step-1",
    name: "Fix foo",
    description: "Fix the foo module",
    action: "modify",
    target: "src/foo.ts",
    dependencies: [],
    status: "pending",
    ...overrides,
  };
}

function makePipelineResult(
  overrides: Partial<PipelineResult> = {},
): PipelineResult {
  return {
    skipped: false,
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
  workspacePath: "/workspace",
  repoPath: "/repo",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createIterateCodebaseTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSingleStep = vi.fn();
    mockGetSubagentBackend.mockReturnValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Tool metadata
  // -------------------------------------------------------------------------

  describe("tool metadata", () => {
    it("has correct name", () => {
      expect(ITERATE_CODEBASE_TOOL.name).toBe("iterate_codebase");
    });

    it("has a description", () => {
      expect(ITERATE_CODEBASE_TOOL.description).toBeTruthy();
      expect(ITERATE_CODEBASE_TOOL.description).toContain("iteration");
    });

    it("defines dryRun parameter as boolean", () => {
      const props = ITERATE_CODEBASE_TOOL.parameters?.properties as Record<
        string,
        { type: string }
      >;
      expect(props.dryRun).toBeDefined();
      expect(props.dryRun.type).toBe("boolean");
    });

    it("returns a valid ToolEntry", () => {
      const entry = createIterateCodebaseTool(DEFAULT_CONFIG);
      expect(entry.tool).toBe(ITERATE_CODEBASE_TOOL);
      expect(typeof entry.handler).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // dry-run mode
  // -------------------------------------------------------------------------

  describe("dry-run mode", () => {
    it("passes dryRun: true to pipeline.runSingleStep", async () => {
      const step = makeStep();
      const pipelineResult = makePipelineResult({ step });
      mockRunSingleStep.mockResolvedValue(pipelineResult);

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      const raw = await handler({ dryRun: true });
      const result = JSON.parse(raw);

      expect(mockRunSingleStep).toHaveBeenCalledWith({ dryRun: true });
      expect(result.step).toEqual(step);
      expect(result.pr).toBeUndefined();
    });

    it("does not execute when dryRun is set", async () => {
      const pipelineResult = makePipelineResult({
        skipped: false,
        step: makeStep(),
      });
      mockRunSingleStep.mockResolvedValue(pipelineResult);

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      await handler({ dryRun: true });

      // Pipeline was called with dryRun — the pipeline itself handles skipping execution
      expect(mockRunSingleStep).toHaveBeenCalledWith({ dryRun: true });
    });
  });

  // -------------------------------------------------------------------------
  // pending iter/* PR skip
  // -------------------------------------------------------------------------

  describe("pending iter/* PR skip", () => {
    it("returns skipped result when pending PR exists", async () => {
      const pipelineResult = makePipelineResult({
        skipped: true,
        skipReason: "pending_pr",
        pendingPR: {
          url: "https://github.com/org/repo/pull/42",
          number: 42,
        },
      });
      mockRunSingleStep.mockResolvedValue(pipelineResult);

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      const raw = await handler({});
      const result = JSON.parse(raw);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("pending_pr");
      expect(result.pendingPR.number).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // normal execution flow
  // -------------------------------------------------------------------------

  describe("normal execution flow", () => {
    it("constructs pipeline with planner, executor, reporter and repoPath", async () => {
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool({
        workspacePath: "/my/workspace",
        repoPath: "/my/repo",
      });
      await handler({});

      // IterationPipeline constructor was called
      expect(IterationPipeline).toHaveBeenCalledOnce();
      expect(capturedConstructorArgs.repoPath).toBe("/my/repo");
    });

    it("creates planner with workspacePath", async () => {
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool({
        workspacePath: "/my/workspace",
        repoPath: "/my/repo",
      });
      await handler({});

      expect(IterationPlanner).toHaveBeenCalledWith({
        workspacePath: "/my/workspace",
      });
    });

    it("creates executor with workspacePath", async () => {
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool({
        workspacePath: "/ws",
        repoPath: "/repo",
      });
      await handler({});

      expect(IterationExecutor).toHaveBeenCalledWith({
        workspacePath: "/ws",
        subagent: undefined,
      });
    });

    it("returns JSON-stringified pipeline result on success", async () => {
      const step = makeStep();
      const pipelineResult = makePipelineResult({
        step,
        executionResult: { success: true, output: "done", duration: 100 },
        validation: { success: true },
        pr: { url: "https://github.com/org/repo/pull/99", number: 99 },
      });
      mockRunSingleStep.mockResolvedValue(pipelineResult);

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      const raw = await handler({});
      const result = JSON.parse(raw);

      expect(result.skipped).toBe(false);
      expect(result.step.id).toBe("step-1");
      expect(result.pr.number).toBe(99);
      expect(result.executionResult.success).toBe(true);
    });

    it("passes dryRun: false by default (undefined args)", async () => {
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      await handler(undefined);

      expect(mockRunSingleStep).toHaveBeenCalledWith({ dryRun: undefined });
    });
  });

  // -------------------------------------------------------------------------
  // error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("catches Error and returns { success: false, error }", async () => {
      mockRunSingleStep.mockRejectedValue(new Error("git exploded"));

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      const raw = await handler({});
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toBe("git exploded");
    });

    it("catches non-Error throw and returns stringified error", async () => {
      mockRunSingleStep.mockRejectedValue("string error");

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      const raw = await handler({});
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });

    it("returns execution failure from pipeline (not thrown)", async () => {
      const pipelineResult = makePipelineResult({
        skipped: false,
        step: makeStep(),
        executionResult: {
          success: false,
          error: new Error("compile error"),
          duration: 50,
        },
        error: "Execution failed: compile error",
      });
      mockRunSingleStep.mockResolvedValue(pipelineResult);

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      const raw = await handler({});
      const result = JSON.parse(raw);

      expect(result.error).toContain("Execution failed");
      expect(result.executionResult.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // subagentEnabled: false — stub executor
  // -------------------------------------------------------------------------

  describe("subagentEnabled config", () => {
    it("does not call getSubagentBackend when subagentEnabled is false", async () => {
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool({
        ...DEFAULT_CONFIG,
        subagentEnabled: false,
      });
      await handler({});

      expect(mockGetSubagentBackend).not.toHaveBeenCalled();
    });

    it("does not call getSubagentBackend when subagentEnabled is undefined", async () => {
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool(DEFAULT_CONFIG);
      await handler({});

      expect(mockGetSubagentBackend).not.toHaveBeenCalled();
    });

    it("calls getSubagentBackend with allowedWorkspaces when subagentEnabled is true", async () => {
      const mockBackend = { spawn: vi.fn() };
      mockGetSubagentBackend.mockReturnValue(mockBackend);
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool({
        ...DEFAULT_CONFIG,
        subagentEnabled: true,
        allowedWorkspaces: ["/ws1", "/ws2"],
      });
      await handler({});

      expect(mockGetSubagentBackend).toHaveBeenCalledWith(["/ws1", "/ws2"]);
      expect(IterationExecutor).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        subagent: mockBackend,
      });
    });

    it("passes undefined subagent to executor when getSubagentBackend returns undefined", async () => {
      mockGetSubagentBackend.mockReturnValue(undefined);
      mockRunSingleStep.mockResolvedValue(makePipelineResult());

      const { handler } = createIterateCodebaseTool({
        ...DEFAULT_CONFIG,
        subagentEnabled: true,
      });
      await handler({});

      expect(IterationExecutor).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        subagent: undefined,
      });
    });
  });
});
