// src/transports/reply-directive.test.ts

import { describe, it, expect } from "vitest";
import { parseReplyDirective, createReplyResolver } from "./reply-directive.js";

describe("parseReplyDirective", () => {
  it("returns input unchanged when no directive present", () => {
    const r = parseReplyDirective("hello world");
    expect(r.stripped).toBe("hello world");
    expect(r.explicitReplyToId).toBeUndefined();
    expect(r.useCurrent).toBe(false);
  });

  it("extracts and strips [[reply_to: <id>]]", () => {
    const r = parseReplyDirective("hi [[reply_to: 12345]] there");
    expect(r.stripped).toBe("hi  there");
    expect(r.explicitReplyToId).toBe("12345");
    expect(r.useCurrent).toBe(false);
  });

  it("extracts and strips [[reply_to_current]]", () => {
    const r = parseReplyDirective("[[reply_to_current]]\nhello");
    expect(r.stripped).toBe("hello");
    expect(r.useCurrent).toBe(true);
    expect(r.explicitReplyToId).toBeUndefined();
  });

  it("last explicit id wins when multiple present", () => {
    const r = parseReplyDirective("[[reply_to: a]] x [[reply_to: b]]");
    expect(r.explicitReplyToId).toBe("b");
  });

  it("trims whitespace inside the id", () => {
    const r = parseReplyDirective("[[ reply_to :  abc-123  ]]");
    expect(r.explicitReplyToId).toBe("abc-123");
  });

  it("is case-insensitive on the tag name", () => {
    const r = parseReplyDirective("[[REPLY_TO: 9]]");
    expect(r.explicitReplyToId).toBe("9");
  });

  it("collapses trailing whitespace before newlines after stripping", () => {
    const r = parseReplyDirective("text  [[reply_to_current]]\nmore");
    expect(r.stripped).toBe("text\nmore");
  });
});

describe("createReplyResolver", () => {
  it("returns no replyToId when mode=off and no directives", () => {
    const resolve = createReplyResolver({ mode: "off", triggerMessageId: "t1" });
    const a = resolve("hello");
    const b = resolve("world");
    expect(a.replyToId).toBeUndefined();
    expect(b.replyToId).toBeUndefined();
  });

  it("mode=first stamps only the first chunk", () => {
    const resolve = createReplyResolver({ mode: "first", triggerMessageId: "t1" });
    expect(resolve("a").replyToId).toBe("t1");
    expect(resolve("b").replyToId).toBeUndefined();
    expect(resolve("c").replyToId).toBeUndefined();
  });

  it("mode=all stamps every chunk", () => {
    const resolve = createReplyResolver({ mode: "all", triggerMessageId: "t1" });
    expect(resolve("a").replyToId).toBe("t1");
    expect(resolve("b").replyToId).toBe("t1");
  });

  it("mode=all defers to inline directive on a later chunk and stops stamping after", () => {
    const resolve = createReplyResolver({ mode: "all", triggerMessageId: "t1" });
    expect(resolve("a").replyToId).toBe("t1");
    expect(resolve("b [[reply_to: m9]]").replyToId).toBe("m9");
    expect(resolve("c").replyToId).toBeUndefined();
  });

  it("inline [[reply_to: id]] overrides config and is single-use", () => {
    const resolve = createReplyResolver({ mode: "off", triggerMessageId: "t1" });
    const a = resolve("hi [[reply_to: m9]]");
    const b = resolve("then this");
    expect(a.replyToId).toBe("m9");
    expect(a.stripped).toBe("hi ");
    expect(b.replyToId).toBeUndefined();
  });

  it("inline [[reply_to_current]] uses trigger id and is single-use", () => {
    const resolve = createReplyResolver({ mode: "off", triggerMessageId: "trig" });
    const a = resolve("[[reply_to_current]] hello");
    const b = resolve("more");
    expect(a.replyToId).toBe("trig");
    expect(a.stripped).toBe(" hello");
    expect(b.replyToId).toBeUndefined();
  });

  it("[[reply_to_current]] is a no-op when no trigger id is given", () => {
    const resolve = createReplyResolver({ mode: "off" });
    expect(resolve("[[reply_to_current]] hi").replyToId).toBeUndefined();
  });

  it("inline directive in first chunk preempts mode=first config", () => {
    const resolve = createReplyResolver({ mode: "first", triggerMessageId: "t1" });
    const a = resolve("[[reply_to: m9]] body");
    const b = resolve("more");
    expect(a.replyToId).toBe("m9");
    expect(b.replyToId).toBeUndefined();
  });
});
