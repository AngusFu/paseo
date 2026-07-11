import { describe, expect, it } from "vitest";
import {
  computeVscodeDiffFile,
  VscodeDiffTimeoutError,
  type VscodeDiffLine,
} from "./vscode-diff-engine.js";

// Pull only the fields relevant to an assertion, ignoring tokens/etc.
function lineSummary(line: VscodeDiffLine) {
  return { type: line.type, content: line.content, changedRanges: line.changedRanges };
}

describe("computeVscodeDiffFile", () => {
  it("maps a simple change with char-level innerChanges", () => {
    const file = computeVscodeDiffFile(
      "example.ts",
      "const foo = 1;\nlet x = 2;",
      "const bar = 1;\nlet x = 2;",
    );

    expect(file.isNew).toBe(false);
    expect(file.isDeleted).toBe(false);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines.map(lineSummary)).toEqual([
      { type: "header", content: "@@ -1,2 +1,2 @@", changedRanges: undefined },
      {
        type: "remove",
        content: "const foo = 1;",
        changedRanges: [{ start: 6, end: 9 }], // "foo"
      },
      {
        type: "add",
        content: "const bar = 1;",
        changedRanges: [{ start: 6, end: 9 }], // "bar"
      },
      { type: "context", content: "let x = 2;", changedRanges: undefined },
    ]);
  });

  it("uses UTF-16 code unit columns for CJK content (no byte conversion needed)", () => {
    const file = computeVscodeDiffFile("notes.md", "ab中文cd", "ab汉字cd");

    expect(file.hunks).toHaveLength(1);
    const [, removeLine, addLine] = file.hunks[0].lines;
    // "中文"/"汉字" sit at code units [2,4) — matches probe.js's directly
    // observed startColumn/endColumn (3/5, 1-based) with no byte math.
    expect(removeLine).toMatchObject({
      type: "remove",
      content: "ab中文cd",
      changedRanges: [{ start: 2, end: 4 }],
    });
    expect(addLine).toMatchObject({
      type: "add",
      content: "ab汉字cd",
      changedRanges: [{ start: 2, end: 4 }],
    });
  });

  it("synthesizes a single whole-file hunk for a created file", () => {
    const file = computeVscodeDiffFile("new.ts", null, "line1\nline2");

    expect(file.isNew).toBe(true);
    expect(file.isDeleted).toBe(false);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 });
    expect(file.hunks[0].lines.map(lineSummary)).toEqual([
      { type: "header", content: "@@ -0,0 +1,2 @@", changedRanges: undefined },
      { type: "add", content: "line1", changedRanges: undefined },
      { type: "add", content: "line2", changedRanges: undefined },
    ]);
  });

  it("synthesizes a single whole-file hunk for a deleted file", () => {
    const file = computeVscodeDiffFile("old.ts", "line1\nline2", null);

    expect(file.isNew).toBe(false);
    expect(file.isDeleted).toBe(true);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(2);
    expect(file.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 });
    expect(file.hunks[0].lines.slice(1).map(lineSummary)).toEqual([
      { type: "remove", content: "line1", changedRanges: undefined },
      { type: "remove", content: "line2", changedRanges: undefined },
    ]);
  });

  it("produces no hunks for a genuinely empty created file", () => {
    const file = computeVscodeDiffFile("empty.ts", null, "");
    expect(file.hunks).toEqual([]);
    expect(file.additions).toBe(0);
  });

  it("throws when neither side of content is provided", () => {
    expect(() => computeVscodeDiffFile("x.ts", null, null)).toThrow(
      /at least one of oldContent\/newContent/,
    );
  });

  it("returns no hunks when content is unchanged", () => {
    const file = computeVscodeDiffFile("same.ts", "a\nb", "a\nb");
    expect(file.hunks).toEqual([]);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it("handles an empty original LineRange (pure insert) inside a modified file", () => {
    const file = computeVscodeDiffFile("list.ts", "a\nb\nc", "a\nX\nb\nc");

    expect(file.hunks).toHaveLength(1);
    // The inserted line is whole-line-changed, so its own changedRanges are
    // suppressed (isWholeLine) in favor of the plain "add" tint.
    expect(file.hunks[0].lines.map(lineSummary)).toEqual([
      { type: "header", content: "@@ -1,3 +1,4 @@", changedRanges: undefined },
      { type: "context", content: "a", changedRanges: undefined },
      { type: "add", content: "X", changedRanges: undefined },
      { type: "context", content: "b", changedRanges: undefined },
      { type: "context", content: "c", changedRanges: undefined },
    ]);
  });

  it("handles an empty modified LineRange (pure delete) inside a modified file", () => {
    const file = computeVscodeDiffFile("list2.ts", "a\nb\nc", "a\nc");

    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines.map(lineSummary)).toEqual([
      { type: "header", content: "@@ -1,3 +1,2 @@", changedRanges: undefined },
      { type: "context", content: "a", changedRanges: undefined },
      { type: "remove", content: "b", changedRanges: undefined },
      { type: "context", content: "c", changedRanges: undefined },
    ]);
  });

  it("merges hunks whose context windows overlap", () => {
    const original = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
    // Line 3 changed, and line 7 deleted — 3 lines of unchanged context (4,5,6)
    // between them, within the 2*HUNK_CONTEXT_LINES(=6) merge threshold.
    const modified = ["1", "2", "CHANGED", "4", "5", "6", "8", "9", "10"];

    const file = computeVscodeDiffFile("merge.ts", original.join("\n"), modified.join("\n"));

    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines.map((l) => l.type)).toEqual([
      "header",
      "context", // 1
      "context", // 2
      "remove", // 3
      "add", // CHANGED
      "context", // 4
      "context", // 5
      "context", // 6
      "remove", // 7
      "context", // 8
      "context", // 9
      "context", // 10
    ]);
  });

  it("keeps hunks separate when unchanged context between them exceeds the merge threshold", () => {
    const original = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const modified = [...original];
    modified[2] = "CHANGED"; // line 3
    modified[18] = "CHANGED2"; // line 19 — 15 unchanged lines away, beyond 2*3

    const file = computeVscodeDiffFile("far.ts", original.join("\n"), modified.join("\n"));

    expect(file.hunks).toHaveLength(2);
  });

  it("renders a moved block as plain remove + add (v1: moves array ignored)", () => {
    const original = [
      "function a() {",
      "  return 1;",
      "}",
      "",
      "function b() {",
      "  return 2;",
      "}",
      "",
      "function c() {",
      "  return 3;",
      "}",
    ];
    const modified = [
      "function b() {",
      "  return 2;",
      "}",
      "",
      "function c() {",
      "  return 3;",
      "}",
      "",
      "function a() {",
      "  return 1;",
      "}",
    ];

    const file = computeVscodeDiffFile("moved.ts", original.join("\n"), modified.join("\n"));

    // No move-specific fields anywhere in the output — a plain two-hunk
    // remove-then-add, exactly like an unrelated delete-and-insert would render.
    expect(file.hunks).toHaveLength(2);

    const removedLines = file.hunks[0].lines
      .filter((l) => l.type === "remove")
      .map((l) => l.content);
    expect(removedLines).toEqual(["function a() {", "  return 1;", "}", ""]);

    const addedLines = file.hunks[1].lines.filter((l) => l.type === "add").map((l) => l.content);
    expect(addedLines).toEqual(["", "function a() {", "  return 1;", "}"]);
  });

  it("throws VscodeDiffTimeoutError when the computation hits maxComputationTimeMs", () => {
    // Fully random, unrelated lines defeat vscode-diff's LCS heuristics, so a
    // 1ms budget reliably trips hitTimeout (0ms would mean "no timeout" — see
    // vscode-diff's own InfiniteTimeout special-case for 0).
    const original = Array.from({ length: 500 }, (_, i) => `${i}-${Math.random().toString(36)}`);
    const modified = Array.from({ length: 500 }, (_, i) => `${i}-${Math.random().toString(36)}-y`);

    expect(() =>
      computeVscodeDiffFile("huge.ts", original.join("\n"), modified.join("\n"), {
        maxComputationTimeMs: 1,
      }),
    ).toThrow(VscodeDiffTimeoutError);
  });
});
