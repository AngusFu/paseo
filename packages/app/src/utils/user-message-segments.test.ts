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

  it("returns a single plain segment for ordinary text", () => {
    expect(pairs(segmentUserMessage("just a normal message"))).toEqual([
      ["plain", "just a normal message"],
    ]);
  });
});
