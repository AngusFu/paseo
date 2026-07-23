import { describe, expect, it } from "vitest";
import { segmentUserMessage, type UserMessageSegment } from "./user-message-segments";

function reassemble(segments: UserMessageSegment[]): string {
  return segments.map((s) => s.text).join("");
}

function pairs(segments: UserMessageSegment[]): Array<[UserMessageSegment["kind"], string]> {
  return segments.map((s) => [s.kind, s.text]);
}

describe("segmentUserMessage", () => {
  it("is lossless", () => {
    const input = "/bug-ticket-fix see https://x.example.com/a done";
    expect(reassemble(segmentUserMessage(input))).toBe(input);
  });

  it("highlights only a leading slash command", () => {
    expect(pairs(segmentUserMessage("/skill-creator make a thing"))).toEqual([
      ["command", "/skill-creator"],
      ["plain", " make a thing"],
    ]);
  });

  it("captures a plugin-namespaced command with a colon", () => {
    expect(pairs(segmentUserMessage("/claude-hud:configure now"))).toEqual([
      ["command", "/claude-hud:configure"],
      ["plain", " now"],
    ]);
  });

  it("does not treat a mid-string slash as a command", () => {
    expect(pairs(segmentUserMessage("run a/b then /c"))).toEqual([["plain", "run a/b then /c"]]);
  });

  it("extracts a URL as its own segment with href", () => {
    const segs = segmentUserMessage("open https://mdpi.atlassian.net/browse/SCIF-4518 now");
    expect(pairs(segs)).toEqual([
      ["plain", "open "],
      ["url", "https://mdpi.atlassian.net/browse/SCIF-4518"],
      ["plain", " now"],
    ]);
    expect(segs[1].href).toBe("https://mdpi.atlassian.net/browse/SCIF-4518");
  });

  it("strips trailing punctuation from a URL into a plain segment", () => {
    expect(pairs(segmentUserMessage("see https://a.example.com/x)."))).toEqual([
      ["plain", "see "],
      ["url", "https://a.example.com/x"],
      ["plain", ")."],
    ]);
  });

  it("combines a leading command with a following URL", () => {
    expect(
      pairs(segmentUserMessage("/bug-ticket-fix https://mdpi.atlassian.net/browse/SCIF-4518")),
    ).toEqual([
      ["command", "/bug-ticket-fix"],
      ["plain", " "],
      ["url", "https://mdpi.atlassian.net/browse/SCIF-4518"],
    ]);
  });

  it("stops a URL at CJK text that follows it without a space", () => {
    expect(pairs(segmentUserMessage("见 https://example.com（注释）继续"))).toEqual([
      ["plain", "见 "],
      ["url", "https://example.com"],
      ["plain", "（注释）继续"],
    ]);
  });

  it("strips full-width punctuation trailing a URL", () => {
    expect(pairs(segmentUserMessage("打开 https://example.com/a。"))).toEqual([
      ["plain", "打开 "],
      ["url", "https://example.com/a"],
      ["plain", "。"],
    ]);
  });

  it("keeps a URL whole when CJK sits before it, not after", () => {
    expect(pairs(segmentUserMessage("工单：https://mdpi.atlassian.net/browse/SCIF-5173"))).toEqual([
      ["plain", "工单："],
      ["url", "https://mdpi.atlassian.net/browse/SCIF-5173"],
    ]);
  });

  it("keeps a long query string with ASCII punctuation intact", () => {
    const url = "https://media.example.net/?type=file&id=9c26aa2e-f2a6&width=1781&url=null";
    expect(pairs(segmentUserMessage(`![](blob:${url})`))).toEqual([
      ["plain", "![](blob:"],
      ["url", url],
      ["plain", ")"],
    ]);
  });

  it("is lossless around CJK", () => {
    const input = "见 https://example.com（注释）继续，另见 https://example.org/a。";
    expect(reassemble(segmentUserMessage(input))).toBe(input);
  });

  it("returns a single plain segment for ordinary text", () => {
    expect(pairs(segmentUserMessage("just a normal message"))).toEqual([
      ["plain", "just a normal message"],
    ]);
  });
});
