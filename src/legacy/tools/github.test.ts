// src/tools/github.test.ts — Unit tests for GitHub CLI wrapper

import { describe, it, expect, vi, beforeEach } from "vitest";
import { exec } from "node:child_process";

// Mock child_process.exec before importing the module under test
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

import {
  listPRs,
  getPR,
  createPR,
  mergePR,
  closePR,
  reviewPR,
  listIssues,
  getIssue,
  createIssue,
  closeIssue,
  commentIssue,
  getRepo,
} from "./github.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecResolve(stdout: string, stderr = "") {
  mockExec.mockResolvedValueOnce({ stdout, stderr });
}

function mockExecReject(error: Error) {
  mockExec.mockRejectedValueOnce(error);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// PR fixtures
// ---------------------------------------------------------------------------

const PR_JSON = [
  {
    number: 42,
    title: "feat: add git tools",
    state: "OPEN",
    author: { login: "alice" },
    url: "https://github.com/org/repo/pull/42",
    body: "Adds git and github wrappers",
    headRefName: "feat/git-tools",
    baseRefName: "main",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-16T11:00:00Z",
  },
];

const ISSUE_JSON = [
  {
    number: 7,
    title: "Bug: crash on startup",
    state: "OPEN",
    author: { login: "bob" },
    url: "https://github.com/org/repo/issues/7",
    body: "App crashes immediately",
    labels: [{ name: "bug" }, { name: "critical" }],
    createdAt: "2024-01-10T09:00:00Z",
    updatedAt: "2024-01-12T14:00:00Z",
  },
];

const REPO_JSON = {
  name: "isotopes",
  owner: { login: "org" },
  description: "AI agent framework",
  url: "https://github.com/org/isotopes",
  defaultBranchRef: { name: "main" },
  isPrivate: false,
};

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

describe("github.listPRs", () => {
  it("lists open PRs and normalizes output", async () => {
    mockExecResolve(JSON.stringify(PR_JSON));

    const prs = await listPRs();

    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      number: 42,
      title: "feat: add git tools",
      state: "OPEN",
      author: "alice",
      url: "https://github.com/org/repo/pull/42",
      body: "Adds git and github wrappers",
      headRefName: "feat/git-tools",
      baseRefName: "main",
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-16T11:00:00Z",
    });
  });

  it("passes state and limit to gh CLI", async () => {
    mockExecResolve("[]");

    await listPRs({ state: "closed", limit: 10 });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--state closed"),
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--limit 10"),
      expect.anything(),
    );
  });
});

describe("github.getPR", () => {
  it("fetches a single PR by number", async () => {
    mockExecResolve(JSON.stringify(PR_JSON[0]));

    const pr = await getPR(42);

    expect(pr.number).toBe(42);
    expect(pr.title).toBe("feat: add git tools");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("pr view 42"),
      expect.anything(),
    );
  });
});

describe("github.createPR", () => {
  it("creates a PR and returns structured data", async () => {
    // First call: gh pr create -> returns URL
    mockExecResolve("https://github.com/org/repo/pull/42");
    // Second call: gh pr view -> returns JSON
    mockExecResolve(JSON.stringify(PR_JSON[0]));

    const pr = await createPR({ title: "feat: new feature", body: "Description" });

    expect(pr.number).toBe(42);
    const firstCall = mockExec.mock.calls[0][0] as string;
    expect(firstCall).toContain("pr create");
    expect(firstCall).toContain("--title");
    expect(firstCall).toContain("--body");
  });

  it("supports draft and base options", async () => {
    mockExecResolve("https://github.com/org/repo/pull/42");
    mockExecResolve(JSON.stringify(PR_JSON[0]));

    await createPR({ title: "Draft PR", draft: true, base: "develop" });

    const firstCall = mockExec.mock.calls[0][0] as string;
    expect(firstCall).toContain("--draft");
    expect(firstCall).toContain("--base develop");
  });
});

describe("github.mergePR", () => {
  it("merges with squash by default", async () => {
    mockExecResolve("Pull request #42 merged");

    const result = await mergePR(42);

    expect(result).toContain("merged");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("pr merge 42 --squash --delete-branch"),
      expect.anything(),
    );
  });

  it("supports merge method options", async () => {
    mockExecResolve("Pull request #42 merged");

    await mergePR(42, { method: "rebase", deleteAfter: false });

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("--rebase");
    expect(cmd).not.toContain("--delete-branch");
  });
});

describe("github.closePR", () => {
  it("closes a PR", async () => {
    mockExecResolve("Closed pull request #42");

    const result = await closePR(42);

    expect(result).toContain("Closed");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("pr close 42"),
      expect.anything(),
    );
  });
});

describe("github.reviewPR", () => {
  it("approves a PR", async () => {
    mockExecResolve("Approved pull request #42");

    await reviewPR({ number: 42, event: "approve" });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("pr review 42 --approve"),
      expect.anything(),
    );
  });

  it("requests changes with body", async () => {
    mockExecResolve("Reviewed pull request #42");

    await reviewPR({ number: 42, event: "request_changes", body: "Please fix" });

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("--request-changes");
    expect(cmd).toContain("--body");
  });

  it("adds a review comment", async () => {
    mockExecResolve("Commented on pull request #42");

    await reviewPR({ number: 42, event: "comment", body: "Looks good overall" });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--comment"),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

describe("github.listIssues", () => {
  it("lists open issues and normalizes output", async () => {
    mockExecResolve(JSON.stringify(ISSUE_JSON));

    const issues = await listIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 7,
      title: "Bug: crash on startup",
      state: "OPEN",
      author: "bob",
      url: "https://github.com/org/repo/issues/7",
      body: "App crashes immediately",
      labels: ["bug", "critical"],
      createdAt: "2024-01-10T09:00:00Z",
      updatedAt: "2024-01-12T14:00:00Z",
    });
  });

  it("passes label filter to gh CLI", async () => {
    mockExecResolve("[]");

    await listIssues({ labels: ["bug", "critical"] });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--label bug,critical"),
      expect.anything(),
    );
  });
});

describe("github.getIssue", () => {
  it("fetches a single issue by number", async () => {
    mockExecResolve(JSON.stringify(ISSUE_JSON[0]));

    const issue = await getIssue(7);

    expect(issue.number).toBe(7);
    expect(issue.labels).toEqual(["bug", "critical"]);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("issue view 7"),
      expect.anything(),
    );
  });
});

describe("github.createIssue", () => {
  it("creates an issue and returns structured data", async () => {
    // First call: gh issue create -> returns URL
    mockExecResolve("https://github.com/org/repo/issues/7");
    // Second call: gh issue view -> returns JSON
    mockExecResolve(JSON.stringify(ISSUE_JSON[0]));

    const issue = await createIssue({
      title: "Bug: crash on startup",
      body: "App crashes immediately",
      labels: ["bug"],
    });

    expect(issue.number).toBe(7);
    const firstCall = mockExec.mock.calls[0][0] as string;
    expect(firstCall).toContain("issue create");
    expect(firstCall).toContain("--title");
    expect(firstCall).toContain("--label bug");
  });

  it("supports assignees", async () => {
    mockExecResolve("https://github.com/org/repo/issues/7");
    mockExecResolve(JSON.stringify(ISSUE_JSON[0]));

    await createIssue({
      title: "Test",
      assignees: ["alice", "bob"],
    });

    const firstCall = mockExec.mock.calls[0][0] as string;
    expect(firstCall).toContain("--assignee alice,bob");
  });
});

describe("github.closeIssue", () => {
  it("closes an issue", async () => {
    mockExecResolve("Closed issue #7");

    const result = await closeIssue(7);

    expect(result).toContain("Closed");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("issue close 7"),
      expect.anything(),
    );
  });
});

describe("github.commentIssue", () => {
  it("adds a comment to an issue", async () => {
    mockExecResolve("Added comment to issue #7");

    const result = await commentIssue(7, "Working on it");

    expect(result).toContain("Added comment");
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("issue comment 7"),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("github.getRepo", () => {
  it("returns normalized repo info", async () => {
    mockExecResolve(JSON.stringify(REPO_JSON));

    const repo = await getRepo();

    expect(repo).toEqual({
      name: "isotopes",
      owner: "org",
      description: "AI agent framework",
      url: "https://github.com/org/isotopes",
      defaultBranch: "main",
      isPrivate: false,
    });
  });

  it("passes cwd option", async () => {
    mockExecResolve(JSON.stringify(REPO_JSON));

    await getRepo({ cwd: "/some/repo" });

    expect(mockExec).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/some/repo" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("propagates exec errors", async () => {
    mockExecReject(new Error("gh: not logged in"));

    await expect(listPRs()).rejects.toThrow("not logged in");
  });

  it("propagates JSON parse errors for malformed output", async () => {
    mockExecResolve("not json");

    await expect(listPRs()).rejects.toThrow();
  });
});
