// src/iteration/planner.test.ts — Unit tests for iteration planner

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { IterationPlanner, createPlanner } from "./planner.js";
import type { ImprovementOpportunity } from "./types.js";

describe("IterationPlanner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-planner-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("analyze", () => {
    it("returns empty opportunities for empty workspace", async () => {
      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.opportunities).toEqual([]);
      expect(result.stats.total).toBe(0);
    });

    it("scans backlog for opportunities", async () => {
      // Create backlog file
      const docsDir = path.join(tempDir, "docs", "ongoing");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(
        path.join(docsDir, "BACKLOG.md"),
        `# Backlog

## Add User Authentication

**Priority:** High

Implement user authentication with OAuth support.

---

## Improve Performance

**Priority:** Medium

Optimize database queries.

---
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.opportunities.length).toBeGreaterThanOrEqual(2);
      expect(result.stats.bySource.backlog).toBeGreaterThanOrEqual(2);

      const authOpp = result.opportunities.find((o) =>
        o.title.includes("User Authentication"),
      );
      expect(authOpp).toBeDefined();
      expect(authOpp?.priority).toBe("high");
      expect(authOpp?.source).toBe("backlog");
    });

    it("scans source files for TODO comments", async () => {
      // Create source file with TODOs
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// src/example.ts

export function doSomething() {
  // TODO: Add error handling
  console.log("hello");
}

// FIXME: This is broken
function broken() {}

// HACK: Temporary workaround
const temp = 42;
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.stats.bySource.todo).toBeGreaterThanOrEqual(3);

      // Check priorities based on comment type
      const fixme = result.opportunities.find((o) =>
        o.description.includes("broken"),
      );
      expect(fixme?.priority).toBe("high");

      const hack = result.opportunities.find((o) =>
        o.description.includes("workaround"),
      );
      expect(hack?.priority).toBe("medium");

      const todo = result.opportunities.find((o) =>
        o.description.includes("error handling"),
      );
      expect(todo?.priority).toBe("low");
    });

    it("includes file location for TODO opportunities", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "module.ts"),
        `// First line
// Second line
// TODO: Fix this on line 3
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      const opp = result.opportunities.find((o) =>
        o.description.includes("line 3"),
      );
      expect(opp?.location).toBe("src/module.ts:3");
    });

    it("ignores node_modules directory", async () => {
      // Create TODO in node_modules (should be ignored)
      const nodeModules = path.join(tempDir, "node_modules", "some-pkg");
      await fs.mkdir(nodeModules, { recursive: true });
      await fs.writeFile(
        path.join(nodeModules, "index.ts"),
        "// TODO: Should be ignored",
      );

      // Create TODO in regular src (should be found)
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "index.ts"),
        "// TODO: Should be found",
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.stats.bySource.todo).toBe(1);
      expect(result.opportunities[0].description).toContain("Should be found");
    });

    it("filters by minimum priority", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Low priority task
// FIXME: High priority task
`,
      );

      const planner = new IterationPlanner({
        workspacePath: tempDir,
        minPriority: "high",
      });
      const result = await planner.analyze();

      expect(result.opportunities).toHaveLength(1);
      expect(result.opportunities[0].priority).toBe("high");
    });

    it("limits maximum opportunities", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Task 1
// TODO: Task 2
// TODO: Task 3
// TODO: Task 4
// TODO: Task 5
`,
      );

      const planner = new IterationPlanner({
        workspacePath: tempDir,
        maxOpportunities: 3,
      });
      const result = await planner.analyze();

      expect(result.opportunities).toHaveLength(3);
    });

    it("sorts opportunities by priority", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Low priority
// FIXME: High priority
// HACK: Medium priority
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      // Should be sorted: high, medium, low
      expect(result.opportunities[0].priority).toBe("high");
      expect(result.opportunities[1].priority).toBe("medium");
      expect(result.opportunities[2].priority).toBe("low");
    });

    it("handles missing backlog gracefully", async () => {
      const planner = new IterationPlanner({
        workspacePath: tempDir,
        backlogPath: "nonexistent/BACKLOG.md",
      });
      const result = await planner.analyze();

      // Should succeed without errors
      expect(result.errors).toBeUndefined();
      expect(result.opportunities).toEqual([]);
    });
  });

  describe("generatePlan", () => {
    it("generates plan from opportunity", () => {
      const planner = new IterationPlanner({ workspacePath: tempDir });

      const opportunity: ImprovementOpportunity = {
        source: "backlog",
        title: "Add User Auth",
        description: "Implement OAuth login",
        priority: "high",
      };

      const result = planner.generatePlan(opportunity);

      expect(result.success).toBe(true);
      expect(result.plan).toBeDefined();
      expect(result.plan?.name).toBe("Add User Auth");
      expect(result.plan?.description).toBe("Implement OAuth login");
      expect(result.plan?.priority).toBe("high");
      expect(result.plan?.status).toBe("planned");
      expect(result.plan?.id).toBeDefined();
      expect(result.plan?.createdAt).toBeInstanceOf(Date);
    });

    it("generates steps with dependencies", () => {
      const planner = new IterationPlanner({ workspacePath: tempDir });

      const opportunity: ImprovementOpportunity = {
        source: "todo",
        title: "Fix bug",
        description: "Fix the broken thing",
        location: "src/module.ts:42",
        priority: "high",
      };

      const result = planner.generatePlan(opportunity);

      expect(result.plan?.steps).toHaveLength(3);

      const [analyze, implement, test] = result.plan!.steps;

      // Analyze has no dependencies
      expect(analyze.dependencies).toEqual([]);
      expect(analyze.action).toBe("modify");

      // Implement depends on analyze
      expect(implement.dependencies).toContain(analyze.id);
      expect(implement.action).toBe("modify"); // From TODO source

      // Test depends on implement
      expect(test.dependencies).toContain(implement.id);
      expect(test.action).toBe("test");
    });

    it("sets action based on source", () => {
      const planner = new IterationPlanner({ workspacePath: tempDir });

      // Backlog items create new things
      const backlogResult = planner.generatePlan({
        source: "backlog",
        title: "New feature",
        description: "Add something new",
        priority: "medium",
      });
      expect(backlogResult.plan?.steps[1].action).toBe("create");

      // TODOs modify existing things
      const todoResult = planner.generatePlan({
        source: "todo",
        title: "Fix bug",
        description: "Fix something",
        priority: "high",
      });
      expect(todoResult.plan?.steps[1].action).toBe("modify");
    });

    it("estimates duration based on step count", () => {
      const planner = new IterationPlanner({ workspacePath: tempDir });

      const result = planner.generatePlan({
        source: "backlog",
        title: "Task",
        description: "Do stuff",
        priority: "medium",
      });

      // 3 steps × 15 min = 45 min
      expect(result.plan?.estimatedDuration).toBe(45);
    });

    it("uses location for step targets", () => {
      const planner = new IterationPlanner({ workspacePath: tempDir });

      const result = planner.generatePlan({
        source: "todo",
        title: "Fix bug",
        description: "Fix it",
        location: "src/core/auth.ts:100",
        priority: "high",
      });

      expect(result.plan?.steps[0].target).toBe("src/core/auth.ts:100");
      expect(result.plan?.steps[2].target).toBe("src/core/auth.test.ts:100");
    });
  });

  describe("generatePlans", () => {
    it("generates multiple plans from analysis", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Task 1
// TODO: Task 2
// TODO: Task 3
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const analysis = await planner.analyze();
      const plans = planner.generatePlans(analysis, 2);

      expect(plans).toHaveLength(2);
      expect(plans[0].success).toBe(true);
      expect(plans[1].success).toBe(true);
    });

    it("respects limit parameter", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Task 1
// TODO: Task 2
// TODO: Task 3
// TODO: Task 4
// TODO: Task 5
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const analysis = await planner.analyze();
      const plans = planner.generatePlans(analysis, 3);

      expect(plans).toHaveLength(3);
    });
  });

  describe("createPlanner", () => {
    it("creates planner instance", () => {
      const planner = createPlanner({ workspacePath: tempDir });
      expect(planner).toBeInstanceOf(IterationPlanner);
    });
  });

  describe("backlog parsing", () => {
    it("extracts priority from backlog entries", async () => {
      const docsDir = path.join(tempDir, "docs", "ongoing");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(
        path.join(docsDir, "BACKLOG.md"),
        `# Backlog

## Critical Security Fix

**Priority:** Critical

Fix security vulnerability immediately.

---

## Low Priority Cleanup

**Priority:** Low

Clean up old code.

---
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      const critical = result.opportunities.find((o) =>
        o.title.includes("Security Fix"),
      );
      expect(critical?.priority).toBe("critical");

      const low = result.opportunities.find((o) =>
        o.title.includes("Cleanup"),
      );
      expect(low?.priority).toBe("low");
    });

    it("defaults to medium priority when not specified", async () => {
      const docsDir = path.join(tempDir, "docs", "ongoing");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(
        path.join(docsDir, "BACKLOG.md"),
        `# Backlog

## Some Task

No priority specified here.

---
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.opportunities[0].priority).toBe("medium");
    });

    it("handles custom backlog path", async () => {
      const customDir = path.join(tempDir, "custom");
      await fs.mkdir(customDir, { recursive: true });
      await fs.writeFile(
        path.join(customDir, "TODO.md"),
        `# Backlog

## Custom Task

**Priority:** High

Task from custom path.

---
`,
      );

      const planner = new IterationPlanner({
        workspacePath: tempDir,
        backlogPath: path.join(customDir, "TODO.md"),
      });
      const result = await planner.analyze();

      expect(result.opportunities).toHaveLength(1);
      expect(result.opportunities[0].title).toBe("Custom Task");
    });
  });

  describe("stats computation", () => {
    it("computes stats by source", async () => {
      // Create both backlog and TODO sources
      const docsDir = path.join(tempDir, "docs", "ongoing");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(
        path.join(docsDir, "BACKLOG.md"),
        `# Backlog

## Backlog Item 1

**Priority:** High

Description.

---

## Backlog Item 2

**Priority:** Medium

Description.

---
`,
      );

      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Task 1
// TODO: Task 2
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.stats.total).toBe(4);
      expect(result.stats.bySource.backlog).toBe(2);
      expect(result.stats.bySource.todo).toBe(2);
      expect(result.stats.bySource.issue).toBe(0);
      expect(result.stats.bySource.analysis).toBe(0);
    });

    it("computes stats by priority", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "example.ts"),
        `// TODO: Low 1
// TODO: Low 2
// FIXME: High 1
// HACK: Medium 1
`,
      );

      const planner = new IterationPlanner({ workspacePath: tempDir });
      const result = await planner.analyze();

      expect(result.stats.byPriority.low).toBe(2);
      expect(result.stats.byPriority.medium).toBe(1);
      expect(result.stats.byPriority.high).toBe(1);
      expect(result.stats.byPriority.critical).toBe(0);
    });
  });
});
