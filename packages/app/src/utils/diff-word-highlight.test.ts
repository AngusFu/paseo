import { describe, expect, it } from "vitest";
import type { HighlightToken } from "@getpaseo/highlight";
import { computeWordChangeRanges, splitTokensByChangeRanges } from "./diff-word-highlight";

describe("computeWordChangeRanges", () => {
  it("marks only the changed word in a partial edit", () => {
    const { oldRanges, newRanges } = computeWordChangeRanges(
      "const value = 1;",
      "const value = 2;",
    );
    // "1" vs "2" differ; the surrounding "const value = " and ";" are common.
    const oldChanged = oldRanges.map((r) => "const value = 1;".slice(r.start, r.end));
    const newChanged = newRanges.map((r) => "const value = 2;".slice(r.start, r.end));
    expect(oldChanged.join("")).toContain("1");
    expect(newChanged.join("")).toContain("2");
    expect(oldChanged.join("")).not.toContain("const");
    expect(newChanged.join("")).not.toContain("const");
  });

  it("returns no ranges for identical lines", () => {
    expect(computeWordChangeRanges("same()", "same()")).toEqual({ oldRanges: [], newRanges: [] });
  });

  it("returns no ranges for empty input", () => {
    expect(computeWordChangeRanges("", "abc")).toEqual({ oldRanges: [], newRanges: [] });
    expect(computeWordChangeRanges("abc", "")).toEqual({ oldRanges: [], newRanges: [] });
  });

  it("falls back to whole-line (no ranges) when nothing is shared", () => {
    // A full replacement with no common words: keep the solid line tint.
    expect(computeWordChangeRanges("aaa", "zzz")).toEqual({ oldRanges: [], newRanges: [] });
  });

  it("skips overly long lines as a performance guard", () => {
    const long = "x".repeat(500);
    expect(computeWordChangeRanges(long, `${long}y`)).toEqual({ oldRanges: [], newRanges: [] });
  });

  it("ranges are within bounds and non-overlapping in order", () => {
    const oldCode = "foo(a, b, c)";
    const newCode = "foo(a, x, c)";
    const { newRanges } = computeWordChangeRanges(oldCode, newCode);
    let prevEnd = -1;
    for (const range of newRanges) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(newCode.length);
      expect(range.start).toBeLessThan(range.end);
      expect(range.start).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = range.end;
    }
    expect(newRanges.map((r) => newCode.slice(r.start, r.end)).join("")).toContain("x");
  });
});

describe("splitTokensByChangeRanges", () => {
  const token = (text: string, style: HighlightToken["style"] = null): HighlightToken =>
    ({ text, style }) as HighlightToken;

  it("returns unchanged pieces when there are no ranges", () => {
    const tokens = [token("const "), token("value")];
    const pieces = splitTokensByChangeRanges(tokens, []);
    expect(pieces).toEqual([
      { text: "const ", style: null, changed: false },
      { text: "value", style: null, changed: false },
    ]);
  });

  it("splits a token that straddles a change boundary and preserves style", () => {
    // Single token "value=1"; range covers the trailing "1" (offset 6..7).
    const pieces = splitTokensByChangeRanges([token("value=1", "keyword")], [{ start: 6, end: 7 }]);
    expect(pieces.map((p) => ({ text: p.text, changed: p.changed }))).toEqual([
      { text: "value=", changed: false },
      { text: "1", changed: true },
    ]);
    expect(pieces.every((p) => p.style === "keyword")).toBe(true);
  });

  it("concatenated piece text equals the original token text", () => {
    const tokens = [token("abc"), token("defg"), token("hi")];
    const pieces = splitTokensByChangeRanges(tokens, [{ start: 2, end: 5 }]);
    expect(pieces.map((p) => p.text).join("")).toBe("abcdefghi");
    // The changed span "cde" straddles the first two tokens.
    expect(
      pieces
        .filter((p) => p.changed)
        .map((p) => p.text)
        .join(""),
    ).toBe("cde");
  });
});
