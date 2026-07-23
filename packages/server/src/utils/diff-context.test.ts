import { describe, expect, it } from "vitest";
import { resolveDiffContextSource, sliceContextLines, splitFileLines } from "./diff-context.js";

describe("resolveDiffContextSource", () => {
  it("reads the working tree for uncommitted and base diffs", () => {
    // Both run without a target ref, so git compares against the working tree;
    // reading context from a revision would show stale surroundings.
    expect(resolveDiffContextSource({ mode: "uncommitted" })).toEqual({ kind: "worktree" });
    expect(resolveDiffContextSource({ mode: "base" })).toEqual({ kind: "worktree" });
  });

  it("reads the target revision for a ref comparison", () => {
    expect(resolveDiffContextSource({ mode: "refs", toRef: "v2" })).toEqual({
      kind: "ref",
      ref: "v2",
    });
  });

  it("falls back to the working tree when a ref comparison has no target", () => {
    expect(resolveDiffContextSource({ mode: "refs" })).toEqual({ kind: "worktree" });
    expect(resolveDiffContextSource({ mode: "refs", toRef: "  " })).toEqual({ kind: "worktree" });
  });
});

describe("splitFileLines", () => {
  it("does not invent a line for a trailing newline", () => {
    // Counting the empty tail as a line makes "expand to the end" a range that
    // never reaches the end.
    expect(splitFileLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps a file with no trailing newline whole", () => {
    expect(splitFileLines("a\nb")).toEqual(["a", "b"]);
  });

  it("normalizes CRLF", () => {
    expect(splitFileLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("preserves interior blank lines", () => {
    expect(splitFileLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("returns nothing for an empty file", () => {
    expect(splitFileLines("")).toEqual([]);
  });
});

describe("sliceContextLines", () => {
  const file = ["1", "2", "3", "4", "5"];

  it("returns an inclusive 1-based range", () => {
    expect(sliceContextLines(file, 2, 4)).toEqual({
      startLine: 2,
      lines: ["2", "3", "4"],
      reachedStart: false,
      reachedEnd: false,
    });
  });

  it("clamps past either end and says so", () => {
    expect(sliceContextLines(file, -5, 2)).toMatchObject({
      startLine: 1,
      lines: ["1", "2"],
      reachedStart: true,
      reachedEnd: false,
    });
    expect(sliceContextLines(file, 4, 99)).toMatchObject({
      startLine: 4,
      lines: ["4", "5"],
      reachedEnd: true,
    });
  });

  it("reports both ends for a whole-file request", () => {
    expect(sliceContextLines(file, 1, 5)).toMatchObject({
      reachedStart: true,
      reachedEnd: true,
    });
  });

  it("handles an inverted range as a single line", () => {
    expect(sliceContextLines(file, 3, 1)).toMatchObject({ startLine: 3, lines: ["3"] });
  });

  it("handles an empty file", () => {
    expect(sliceContextLines([], 1, 10)).toEqual({
      startLine: 0,
      lines: [],
      reachedStart: true,
      reachedEnd: true,
    });
  });
});
