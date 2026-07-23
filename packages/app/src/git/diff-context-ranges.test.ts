import { describe, expect, it } from "vitest";
import type { DiffHunk } from "@/git/use-diff-query";
import {
  applyLoadedDiffContext,
  buildDiffContextFileKey,
  computeDiffContextGaps,
  DIFF_CONTEXT_EXPAND_ALL_LIMIT,
  DIFF_CONTEXT_EXPAND_STEP,
  EMPTY_DIFF_FILE_CONTEXT_STATE,
  mergeLoadedDiffContext,
  type DiffContextDirection,
  type DiffContextGap,
  type DiffFileContextState,
} from "./diff-context-ranges";

/**
 * A hunk that changes a single line at `newStart`, with `contextCount` context
 * lines on either side — enough shape for the range arithmetic to chew on.
 */
function hunk(input: { oldStart: number; newStart: number; count: number }): DiffHunk {
  const lines: DiffHunk["lines"] = [
    { type: "header", content: `@@ -${input.oldStart} +${input.newStart} @@` },
  ];
  for (let index = 0; index < input.count; index += 1) {
    lines.push({ type: "context", content: ` line ${input.newStart + index}` });
  }
  return {
    oldStart: input.oldStart,
    oldCount: input.count,
    newStart: input.newStart,
    newCount: input.count,
    lines,
  };
}

function gapById(gaps: DiffContextGap[], id: string): DiffContextGap {
  const found = gaps.find((gap) => gap.id === id);
  if (!found) {
    throw new Error(`no gap ${id} in ${gaps.map((gap) => gap.id).join(", ")}`);
  }
  return found;
}

/** Loads a range as the daemon would, so state transitions can be chained. */
function load(input: {
  state: DiffFileContextState;
  gap: DiffContextGap;
  direction: DiffContextDirection;
  range: { startLine: number; endLine: number };
  fileLineCount?: number;
}): DiffFileContextState {
  const fileLineCount = input.fileLineCount ?? Number.POSITIVE_INFINITY;
  const startLine = Math.max(1, Math.min(input.range.startLine, fileLineCount));
  const endLine = Math.min(input.range.endLine, fileLineCount);
  const lines: string[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    lines.push(`line ${lineNumber}`);
  }
  return applyLoadedDiffContext({
    state: input.state,
    gap: input.gap,
    direction: input.direction,
    response: { startLine, lines, reachedEnd: endLine >= fileLineCount },
  });
}

function contextContents(hunks: DiffHunk[]): string[][] {
  return hunks.map((entry) => entry.lines.map((line) => line.content));
}

describe("computeDiffContextGaps", () => {
  it("offers only expand-all for a gap smaller than one step", () => {
    // Lines 11..15 are hidden — five lines, fewer than the step, so three
    // controls that all did the same thing would be noise.
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 10 }),
      hunk({ oldStart: 16, newStart: 16, count: 4 }),
    ];

    const gap = gapById(computeDiffContextGaps({ hunks }), "between:11");

    expect(gap.hiddenCount).toBe(5);
    expect(gap.expandUp).toBeNull();
    expect(gap.expandDown).toBeNull();
    expect(gap.expandAll).toEqual({ startLine: 11, endLine: 15 });
  });

  it("retires every control once that gap is fully loaded", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 10 }),
      hunk({ oldStart: 16, newStart: 16, count: 4 }),
    ];
    const gap = gapById(computeDiffContextGaps({ hunks }), "between:11");

    const state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "all",
      range: { startLine: 11, endLine: 15 },
    });
    const reloaded = gapById(computeDiffContextGaps({ hunks, state }), "between:11");

    expect(reloaded.hiddenCount).toBe(0);
    expect(reloaded.expandAll).toBeNull();
    expect(reloaded.expandUp).toBeNull();
    expect(reloaded.expandDown).toBeNull();
  });

  it("expands above the first hunk upwards only", () => {
    const hunks = [hunk({ oldStart: 101, newStart: 101, count: 4 })];

    const gap = gapById(computeDiffContextGaps({ hunks }), "leading:1");

    expect(gap.start).toBe(1);
    expect(gap.end).toBe(100);
    // Nothing sits above the top of the file, so there is no "expand down" here.
    expect(gap.expandDown).toBeNull();
    expect(gap.expandUp).toEqual({ startLine: 100 - DIFF_CONTEXT_EXPAND_STEP + 1, endLine: 100 });
    expect(gap.expandAll).toEqual({ startLine: 1, endLine: 100 });
  });

  it("expands below the last hunk downwards, until a response reports the file end", () => {
    const hunks = [hunk({ oldStart: 1, newStart: 1, count: 4 })];

    const gap = gapById(computeDiffContextGaps({ hunks }), "trailing:5");

    expect(gap.end).toBeNull();
    expect(gap.hiddenCount).toBeNull();
    expect(gap.expandUp).toBeNull();
    expect(gap.expandDown).toEqual({ startLine: 5, endLine: 5 + DIFF_CONTEXT_EXPAND_STEP - 1 });
    expect(gap.expandAll).toEqual({
      startLine: 5,
      endLine: 5 + DIFF_CONTEXT_EXPAND_ALL_LIMIT - 1,
    });

    const state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "down",
      range: gap.expandDown ?? { startLine: 0, endLine: 0 },
      fileLineCount: 12,
    });
    const reloaded = gapById(computeDiffContextGaps({ hunks, state }), "trailing:5");

    expect(state.fileLineCount).toBe(12);
    expect(reloaded.hiddenCount).toBe(0);
    expect(reloaded.expandDown).toBeNull();
    expect(reloaded.expandAll).toBeNull();
  });

  it("walks a large gap one step at a time from both ends", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 3 }),
      hunk({ oldStart: 204, newStart: 204, count: 3 }),
    ];
    const first = gapById(computeDiffContextGaps({ hunks }), "between:4");

    expect(first.hiddenCount).toBe(200);
    expect(first.expandDown).toEqual({ startLine: 4, endLine: 23 });
    expect(first.expandUp).toEqual({ startLine: 184, endLine: 203 });

    const afterDown = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap: first,
      direction: "down",
      range: { startLine: 4, endLine: 23 },
    });
    const second = gapById(computeDiffContextGaps({ hunks, state: afterDown }), "between:4");

    expect(second.hiddenCount).toBe(180);
    // A second click continues from where the first one stopped.
    expect(second.expandDown).toEqual({ startLine: 24, endLine: 43 });
    expect(second.expandUp).toEqual({ startLine: 184, endLine: 203 });

    const afterUp = load({
      state: afterDown,
      gap: second,
      direction: "up",
      range: { startLine: 184, endLine: 203 },
    });
    const third = gapById(computeDiffContextGaps({ hunks, state: afterUp }), "between:4");

    expect(third.hiddenCount).toBe(160);
    expect(third.head).toEqual({ startLine: 4, endLine: 23 });
    expect(third.tail).toEqual({ startLine: 184, endLine: 203 });
  });

  it("has no gap between adjacent hunks", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 5 }),
      hunk({ oldStart: 6, newStart: 6, count: 5 }),
    ];

    const gaps = computeDiffContextGaps({ hunks });

    expect(gaps.map((gap) => gap.id)).toEqual(["trailing:11"]);
  });

  it("gives a single-hunk file its leading and trailing gaps and nothing else", () => {
    const gaps = computeDiffContextGaps({
      hunks: [hunk({ oldStart: 40, newStart: 40, count: 6 })],
    });

    expect(gaps.map((gap) => gap.kind)).toEqual(["leading", "trailing"]);
  });

  it("has no gaps at all for a file with no hunks", () => {
    expect(computeDiffContextGaps({ hunks: [] })).toEqual([]);
  });
});

describe("applyLoadedDiffContext", () => {
  it("joins the two blocks once they meet", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 3 }),
      hunk({ oldStart: 34, newStart: 34, count: 3 }),
    ];
    const gaps = () => computeDiffContextGaps({ hunks, state });
    let state = EMPTY_DIFF_FILE_CONTEXT_STATE;

    state = load({
      state,
      gap: gapById(gaps(), "between:4"),
      direction: "down",
      range: { startLine: 4, endLine: 23 },
    });
    const remaining = gapById(gaps(), "between:4");

    expect(remaining.hiddenCount).toBe(10);
    expect(remaining.expandAll).toEqual({ startLine: 24, endLine: 33 });

    state = load({
      state,
      gap: remaining,
      direction: "all",
      range: { startLine: 24, endLine: 33 },
    });

    expect(state.blocksByGapId["between:4"]).toEqual({
      head: { startLine: 4, endLine: 33 },
      tail: null,
    });
  });

  it("keeps the leading gap in the block anchored to the hunk below it", () => {
    const hunks = [hunk({ oldStart: 51, newStart: 51, count: 3 })];
    const gap = gapById(computeDiffContextGaps({ hunks }), "leading:1");

    const state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "all",
      range: { startLine: 1, endLine: 50 },
    });

    expect(state.blocksByGapId["leading:1"]).toEqual({
      head: null,
      tail: { startLine: 1, endLine: 50 },
    });
  });

  it("records the file length when a response reaches the end", () => {
    const hunks = [hunk({ oldStart: 1, newStart: 1, count: 3 })];
    const gap = gapById(computeDiffContextGaps({ hunks }), "trailing:4");

    const state = applyLoadedDiffContext({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "down",
      response: { startLine: 4, lines: ["line 4", "line 5"], reachedEnd: true },
    });

    expect(state.fileLineCount).toBe(5);
  });
});

describe("mergeLoadedDiffContext", () => {
  it("folds a closed gap into a single hunk with continuous line numbers", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 3 }),
      hunk({ oldStart: 9, newStart: 9, count: 2 }),
    ];
    const gap = gapById(computeDiffContextGaps({ hunks }), "between:4");
    const state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "all",
      range: { startLine: 4, endLine: 8 },
    });

    const merged = mergeLoadedDiffContext({
      hunks,
      gaps: computeDiffContextGaps({ hunks, state }),
      state,
    });

    expect(merged.hunks).toHaveLength(1);
    expect(merged.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 10, newStart: 1, newCount: 10 });
    expect(contextContents(merged.hunks)[0]).toEqual([
      "@@ -1 +1 @@",
      " line 1",
      " line 2",
      " line 3",
      " line 4",
      " line 5",
      " line 6",
      " line 7",
      " line 8",
      " line 9",
      " line 10",
    ]);
    expect(merged.gapIdByHunkIndex).toEqual([null]);
  });

  it("splits a partly loaded gap between the hunk above and the hunk below", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 3 }),
      hunk({ oldStart: 104, newStart: 104, count: 2 }),
    ];
    let state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap: gapById(computeDiffContextGaps({ hunks }), "between:4"),
      direction: "down",
      range: { startLine: 4, endLine: 5 },
    });
    state = load({
      state,
      gap: gapById(computeDiffContextGaps({ hunks, state }), "between:4"),
      direction: "up",
      range: { startLine: 102, endLine: 103 },
    });

    const merged = mergeLoadedDiffContext({
      hunks,
      gaps: computeDiffContextGaps({ hunks, state }),
      state,
    });

    expect(merged.hunks).toHaveLength(2);
    // The head block extends the hunk above; its counts grow, its start does not.
    expect(merged.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 5, newStart: 1, newCount: 5 });
    // The tail block extends the hunk below, so that hunk now starts two lines earlier.
    expect(merged.hunks[1]).toMatchObject({
      oldStart: 102,
      oldCount: 4,
      newStart: 102,
      newCount: 4,
    });
    expect(contextContents(merged.hunks)[1]).toEqual([
      "@@ -104 +104 @@",
      " line 102",
      " line 103",
      " line 104",
      " line 105",
    ]);
    // The expander stays on the second hunk's header row while lines are still hidden.
    expect(merged.gapIdByHunkIndex).toEqual([null, "between:4"]);
  });

  it("drops the first header row once the file start is reached", () => {
    const hunks = [hunk({ oldStart: 4, newStart: 4, count: 2 })];
    const gap = gapById(computeDiffContextGaps({ hunks }), "leading:1");
    const state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "all",
      range: { startLine: 1, endLine: 3 },
    });

    const merged = mergeLoadedDiffContext({
      hunks,
      gaps: computeDiffContextGaps({ hunks, state }),
      state,
    });

    expect(merged.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, oldCount: 5, newCount: 5 });
    expect(contextContents(merged.hunks)[0]).toEqual([
      " line 1",
      " line 2",
      " line 3",
      " line 4",
      " line 5",
    ]);
    expect(merged.gapIdByHunkIndex).toEqual([null]);
  });

  it("appends trailing context to the last hunk and keeps its expander until the end of file", () => {
    const hunks = [hunk({ oldStart: 1, newStart: 1, count: 2 })];
    let state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap: gapById(computeDiffContextGaps({ hunks }), "trailing:3"),
      direction: "down",
      range: { startLine: 3, endLine: 4 },
    });

    let merged = mergeLoadedDiffContext({
      hunks,
      gaps: computeDiffContextGaps({ hunks, state }),
      state,
    });
    expect(merged.hunks[0]).toMatchObject({ oldCount: 4, newCount: 4 });
    expect(merged.trailingGapId).toBe("trailing:3");

    state = load({
      state,
      gap: gapById(computeDiffContextGaps({ hunks, state }), "trailing:3"),
      direction: "down",
      range: { startLine: 5, endLine: 24 },
      fileLineCount: 6,
    });
    merged = mergeLoadedDiffContext({
      hunks,
      gaps: computeDiffContextGaps({ hunks, state }),
      state,
    });

    expect(merged.hunks[0]).toMatchObject({ oldCount: 6, newCount: 6 });
    expect(merged.trailingGapId).toBeNull();
  });

  it("leaves adjacent hunks alone", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 5 }),
      hunk({ oldStart: 6, newStart: 6, count: 5 }),
    ];

    const merged = mergeLoadedDiffContext({
      hunks,
      gaps: computeDiffContextGaps({ hunks }),
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
    });

    expect(merged.hunks).toHaveLength(2);
    expect(merged.gapIdByHunkIndex).toEqual([null, null]);
    expect(contextContents(merged.hunks)).toEqual(contextContents([...hunks]));
  });

  it("does not mutate the hunks it was given", () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, count: 3 }),
      hunk({ oldStart: 9, newStart: 9, count: 2 }),
    ];
    const before = JSON.stringify(hunks);
    const gap = gapById(computeDiffContextGaps({ hunks }), "between:4");
    const state = load({
      state: EMPTY_DIFF_FILE_CONTEXT_STATE,
      gap,
      direction: "all",
      range: { startLine: 4, endLine: 8 },
    });

    mergeLoadedDiffContext({ hunks, gaps: computeDiffContextGaps({ hunks, state }), state });

    expect(JSON.stringify(hunks)).toBe(before);
  });
});

describe("buildDiffContextFileKey", () => {
  it("changes when the hunk geometry changes, so stale context is dropped", () => {
    const path = "src/app.ts";
    const before = buildDiffContextFileKey({
      path,
      hunks: [hunk({ oldStart: 1, newStart: 1, count: 3 })],
    });
    const after = buildDiffContextFileKey({
      path,
      hunks: [hunk({ oldStart: 1, newStart: 2, count: 3 })],
    });

    expect(before).not.toBe(after);
  });

  it("is stable for the same file and hunks", () => {
    const hunks = [hunk({ oldStart: 1, newStart: 1, count: 3 })];

    expect(buildDiffContextFileKey({ path: "a.ts", hunks })).toBe(
      buildDiffContextFileKey({ path: "a.ts", hunks }),
    );
  });
});
