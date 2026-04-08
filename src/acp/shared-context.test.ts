// src/acp/shared-context.test.ts — Unit tests for SharedContextManager

import { describe, it, expect, beforeEach } from "vitest";
import { SharedContextManager } from "./shared-context.js";
// SharedContext type used implicitly via manager return types

describe("SharedContextManager", () => {
  let manager: SharedContextManager;

  beforeEach(() => {
    manager = new SharedContextManager();
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe("create", () => {
    it("creates a context with the given name", () => {
      const ctx = manager.create("my-context");

      expect(ctx.id).toBeDefined();
      expect(ctx.name).toBe("my-context");
      expect(ctx.participants).toEqual([]);
      expect(ctx.data).toEqual({});
      expect(ctx.createdAt).toBeInstanceOf(Date);
      expect(ctx.updatedAt).toBeInstanceOf(Date);
    });

    it("creates a context with initial data", () => {
      const ctx = manager.create("with-data", { key: "value", count: 42 });

      expect(ctx.data).toEqual({ key: "value", count: 42 });
    });

    it("assigns unique IDs to each context", () => {
      const c1 = manager.create("ctx-1");
      const c2 = manager.create("ctx-2");

      expect(c1.id).not.toBe(c2.id);
    });

    it("does not mutate the initial data object", () => {
      const initial = { foo: "bar" };
      const ctx = manager.create("test", initial);

      ctx.data.extra = "added";
      expect(initial).toEqual({ foo: "bar" }); // original unchanged
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe("get", () => {
    it("retrieves a context by ID", () => {
      const created = manager.create("test");
      const retrieved = manager.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.name).toBe("test");
    });

    it("returns undefined for unknown ID", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    it("deletes an existing context", () => {
      const ctx = manager.create("to-delete");

      expect(manager.delete(ctx.id)).toBe(true);
      expect(manager.get(ctx.id)).toBeUndefined();
    });

    it("returns false for unknown ID", () => {
      expect(manager.delete("nonexistent")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // join
  // ---------------------------------------------------------------------------

  describe("join", () => {
    it("adds a session to the participant list", () => {
      const ctx = manager.create("team");

      expect(manager.join(ctx.id, "session-1")).toBe(true);
      expect(manager.get(ctx.id)!.participants).toEqual(["session-1"]);
    });

    it("adds multiple sessions", () => {
      const ctx = manager.create("team");

      manager.join(ctx.id, "session-1");
      manager.join(ctx.id, "session-2");

      expect(manager.get(ctx.id)!.participants).toEqual(["session-1", "session-2"]);
    });

    it("returns false if session is already a participant", () => {
      const ctx = manager.create("team");

      expect(manager.join(ctx.id, "session-1")).toBe(true);
      expect(manager.join(ctx.id, "session-1")).toBe(false);
      expect(manager.get(ctx.id)!.participants).toEqual(["session-1"]); // no dupe
    });

    it("returns false for unknown context ID", () => {
      expect(manager.join("nonexistent", "session-1")).toBe(false);
    });

    it("updates the updatedAt timestamp", () => {
      const ctx = manager.create("team");
      const before = ctx.updatedAt;

      manager.join(ctx.id, "session-1");

      expect(manager.get(ctx.id)!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // leave
  // ---------------------------------------------------------------------------

  describe("leave", () => {
    it("removes a session from the participant list", () => {
      const ctx = manager.create("team");
      manager.join(ctx.id, "session-1");
      manager.join(ctx.id, "session-2");

      expect(manager.leave(ctx.id, "session-1")).toBe(true);
      expect(manager.get(ctx.id)!.participants).toEqual(["session-2"]);
    });

    it("returns false if session is not a participant", () => {
      const ctx = manager.create("team");
      expect(manager.leave(ctx.id, "session-unknown")).toBe(false);
    });

    it("returns false for unknown context ID", () => {
      expect(manager.leave("nonexistent", "session-1")).toBe(false);
    });

    it("updates the updatedAt timestamp", () => {
      const ctx = manager.create("team");
      manager.join(ctx.id, "session-1");
      const before = manager.get(ctx.id)!.updatedAt;

      manager.leave(ctx.id, "session-1");

      expect(manager.get(ctx.id)!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  describe("update", () => {
    it("shallow-merges new data into the context", () => {
      const ctx = manager.create("project", { status: "active" });

      const updated = manager.update(ctx.id, { branch: "main", count: 5 });

      expect(updated).toBeDefined();
      expect(updated!.data).toEqual({ status: "active", branch: "main", count: 5 });
    });

    it("overwrites existing keys", () => {
      const ctx = manager.create("project", { status: "active" });

      manager.update(ctx.id, { status: "paused" });

      expect(manager.get(ctx.id)!.data.status).toBe("paused");
    });

    it("returns undefined for unknown context ID", () => {
      expect(manager.update("nonexistent", { foo: "bar" })).toBeUndefined();
    });

    it("updates the updatedAt timestamp", () => {
      const ctx = manager.create("project");
      const before = ctx.updatedAt;

      manager.update(ctx.id, { key: "value" });

      expect(manager.get(ctx.id)!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getBySession
  // ---------------------------------------------------------------------------

  describe("getBySession", () => {
    it("returns all contexts a session participates in", () => {
      const c1 = manager.create("ctx-1");
      const c2 = manager.create("ctx-2");
      const c3 = manager.create("ctx-3");

      manager.join(c1.id, "session-1");
      manager.join(c2.id, "session-1");
      manager.join(c3.id, "session-2");

      const result = manager.getBySession("session-1");
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.name).sort()).toEqual(["ctx-1", "ctx-2"]);
    });

    it("returns empty array for unknown session", () => {
      manager.create("ctx-1");
      expect(manager.getBySession("session-unknown")).toEqual([]);
    });

    it("returns empty array when no contexts exist", () => {
      expect(manager.getBySession("session-1")).toEqual([]);
    });

    it("excludes contexts after leaving", () => {
      const ctx = manager.create("team");
      manager.join(ctx.id, "session-1");

      expect(manager.getBySession("session-1")).toHaveLength(1);

      manager.leave(ctx.id, "session-1");

      expect(manager.getBySession("session-1")).toHaveLength(0);
    });
  });
});
