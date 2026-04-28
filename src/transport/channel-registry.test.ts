// src/transport/channel-registry.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { ChannelRegistry } from "./channel-registry.js";

describe("ChannelRegistry", () => {
  let r: ChannelRegistry;
  beforeEach(() => { r = new ChannelRegistry(); });

  it("adds and queries agents in a channel", () => {
    r.addAgent("discord:1", "main");
    r.addAgent("discord:1", "eous");
    expect(r.getAgents("discord:1").sort()).toEqual(["eous", "main"]);
    expect(r.has("discord:1", "main")).toBe(true);
    expect(r.has("discord:1", "ghost")).toBe(false);
  });

  it("dedupes adds", () => {
    r.addAgent("c", "a");
    r.addAgent("c", "a");
    expect(r.getAgents("c")).toEqual(["a"]);
  });

  it("removes agents and prunes empty channels", () => {
    r.addAgent("c", "a");
    expect(r.removeAgent("c", "a")).toBe(true);
    expect(r.channelCount).toBe(0);
    expect(r.removeAgent("c", "a")).toBe(false);
  });

  it("lists channels for an agent", () => {
    r.addAgent("c1", "main");
    r.addAgent("c2", "main");
    r.addAgent("c2", "eous");
    expect(r.getChannels("main").sort()).toEqual(["c1", "c2"]);
    expect(r.getChannels("eous")).toEqual(["c2"]);
    expect(r.getChannels("nobody")).toEqual([]);
  });

  it("returns empty for unknown channel", () => {
    expect(r.getAgents("none")).toEqual([]);
  });

  it("clears all", () => {
    r.addAgent("c", "a");
    r.clear();
    expect(r.channelCount).toBe(0);
  });
});
