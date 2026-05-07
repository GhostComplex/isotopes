import { describe, it, expect } from "vitest";
import { parseReplyDirective, REPLY_DIRECTIVE_PROMPT } from "./reply-directive.js";

describe("parseReplyDirective", () => {
  it("returns text unchanged when no directives present", () => {
    expect(parseReplyDirective("hello world")).toEqual({ stripped: "hello world" });
  });

  it("strips [[reply_to_current]] and resolves to triggerMessageId", () => {
    const r = parseReplyDirective("[[reply_to_current]]\nhello", "msg-123");
    expect(r.replyToId).toBe("msg-123");
    expect(r.stripped).toBe("hello");
  });

  it("returns no replyToId for [[reply_to_current]] when triggerMessageId missing", () => {
    const r = parseReplyDirective("[[reply_to_current]]\nhello");
    expect(r.replyToId).toBeUndefined();
    expect(r.stripped).toBe("hello");
  });

  it("strips [[reply_to: <id>]] and uses the explicit id", () => {
    const r = parseReplyDirective("[[reply_to: 9876]]\nhello", "msg-123");
    expect(r.replyToId).toBe("9876");
    expect(r.stripped).toBe("hello");
  });

  it("explicit id wins over current", () => {
    const r = parseReplyDirective("[[reply_to_current]] [[reply_to: 9876]]", "msg-123");
    expect(r.replyToId).toBe("9876");
  });

  it("removes inline directive without leaving blank line when not alone on line", () => {
    const r = parseReplyDirective("hi [[reply_to_current]] there", "m");
    expect(r.stripped).toBe("hi  there");
  });

  it("eats the whole line when directive sits alone on its line", () => {
    const r = parseReplyDirective("intro\n[[reply_to_current]]\nbody", "m");
    expect(r.stripped).toBe("intro\nbody");
  });

  it("trims whitespace inside brackets", () => {
    const r = parseReplyDirective("[[reply_to:   abc-123  ]]");
    expect(r.replyToId).toBe("abc-123");
  });
});

describe("REPLY_DIRECTIVE_PROMPT", () => {
  it("teaches both directive forms", () => {
    expect(REPLY_DIRECTIVE_PROMPT).toContain("[[reply_to_current]]");
    expect(REPLY_DIRECTIVE_PROMPT).toContain("[[reply_to: <message-id>]]");
  });
});
