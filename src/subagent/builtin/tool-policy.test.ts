// src/subagent/builtin/tool-policy.test.ts — Unit tests for builtin tool policy

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../core/tools.js";
import {
  DENY_ALWAYS,
  DENY_LEAF,
  resolveBuiltinToolPolicy,
  filterToolRegistry,
} from "./tool-policy.js";

function makeRegistry(names: string[]): ToolRegistry {
  const r = new ToolRegistry("test");
  for (const name of names) {
    r.register(
      { name, description: name, parameters: { type: "object", properties: {} } },
      async () => `result of ${name}`,
    );
  }
  return r;
}

describe("resolveBuiltinToolPolicy", () => {
  it("returns DENY_LEAF for leaf role", () => {
    const policy = resolveBuiltinToolPolicy("leaf");
    expect(policy.deny).toBe(DENY_LEAF);
    expect(policy.deny.has("spawn_subagent")).toBe(true);
    expect(policy.deny.has("write_file")).toBe(true);
  });

  it("returns DENY_ALWAYS (no spawn_subagent block) for orchestrator role", () => {
    const policy = resolveBuiltinToolPolicy("orchestrator");
    expect(policy.deny).toBe(DENY_ALWAYS);
    expect(policy.deny.has("spawn_subagent")).toBe(false);
    expect(policy.deny.has("write_file")).toBe(true);
  });
});

describe("filterToolRegistry", () => {
  it("removes denied tools and keeps the rest", () => {
    const parent = makeRegistry([
      "read_file",
      "write_file",
      "edit",
      "web_fetch",
      "web_search",
      "spawn_subagent",
      "shell",
      "list_dir",
    ]);
    const filtered = filterToolRegistry(parent, resolveBuiltinToolPolicy("leaf"));
    const names = filtered.list().map((t) => t.name).sort();
    expect(names).toEqual(["list_dir", "read_file", "shell"]);
  });

  it("does not mutate the parent registry", () => {
    const parent = makeRegistry(["read_file", "write_file"]);
    filterToolRegistry(parent, resolveBuiltinToolPolicy("leaf"));
    expect(parent.has("write_file")).toBe(true);
    expect(parent.has("read_file")).toBe(true);
  });

  it("preserves tool handlers on the filtered registry", async () => {
    const parent = makeRegistry(["read_file"]);
    const filtered = filterToolRegistry(parent, resolveBuiltinToolPolicy("leaf"));
    expect(await filtered.execute("read_file", {})).toBe("result of read_file");
  });

  it("orchestrator policy keeps spawn_subagent available", () => {
    const parent = makeRegistry(["spawn_subagent", "write_file", "shell"]);
    const filtered = filterToolRegistry(parent, resolveBuiltinToolPolicy("orchestrator"));
    expect(filtered.has("spawn_subagent")).toBe(true);
    expect(filtered.has("write_file")).toBe(false);
    expect(filtered.has("shell")).toBe(true);
  });
});
