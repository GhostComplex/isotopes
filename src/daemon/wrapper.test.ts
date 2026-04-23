// src/daemon/wrapper.test.ts — Tests for the process restart wrapper

import { describe, it, expect } from "vitest";
import { RESTART_EXIT_CODE } from "./wrapper.js";

describe("wrapper constants", () => {
  it("uses exit code 75 for restart", () => {
    expect(RESTART_EXIT_CODE).toBe(75);
  });
});
