/**
 * Range arithmetic for GitLab-style context expansion in the diff viewer.
 *
 * A diff only carries a few lines either side of a change. The gaps in between
 * are elided, and the daemon can hand back any range of the new side on demand
 * (`checkout.diff.context`). This module owns the bookkeeping: which gaps a file
 * has, what each expand affordance would ask for, and how the loaded lines fold
 * back into the hunks so the existing renderer draws them as ordinary context.
 *
 * Every line number here is 1-based and on the NEW side of the diff, matching
 * the daemon's request/response contract.
 *
 * A gap grows from both ends and the two blocks are named for where they sit:
 *
 *     ── hunk above ──────────
 *       head   ← "expand down" grows this, revealing what follows the hunk above
 *       (hidden)
 *       tail   ← "expand up" grows this, revealing what precedes the hunk below
 *     ── hunk below ──────────
 *
 * Once the two blocks meet, the gap is gone and the hunks either side of it are
 * merged into one, which is what retires the expander row.
 */

import type { DiffHunk, DiffLine } from "@/git/use-diff-query";

/** Lines a single expand step pulls in. Fixed at 20, the step GitLab unfolds by. */
export const DIFF_CONTEXT_EXPAND_STEP = 20;

/**
 * Ceiling on one "expand all" past the last hunk, where the end of the file is
 * unknown until a response reports it. Bounded gaps always expand in full; this
 * only stops "show the rest of the file" from pulling a whole large file in one
 * request — the expander stays put and another click continues.
 */
export const DIFF_CONTEXT_EXPAND_ALL_LIMIT = 1000;

/** Inclusive 1-based range on the new side. */
export interface DiffLineRange {
  startLine: number;
  endLine: number;
}

export type DiffContextDirection = "up" | "down" | "all";

export type DiffGapKind = "leading" | "between" | "trailing";

/** The two contiguous loaded blocks of a single gap. */
export interface DiffGapBlocks {
  head: DiffLineRange | null;
  tail: DiffLineRange | null;
}

/** Everything loaded for one file, plus what the responses revealed about it. */
export interface DiffFileContextState {
  blocksByGapId: Readonly<Record<string, DiffGapBlocks>>;
  /** Text of every loaded line, keyed by its new-side line number. */
  linesByNumber: ReadonlyMap<number, string>;
  /** Known once a response reported the end of the file; bounds the trailing gap. */
  fileLineCount: number | null;
}

export const EMPTY_DIFF_FILE_CONTEXT_STATE: DiffFileContextState = {
  blocksByGapId: {},
  linesByNumber: new Map(),
  fileLineCount: null,
};

export interface DiffContextGap {
  /** Stable across expansion: derived from the gap's position in the original hunks. */
  id: string;
  kind: DiffGapKind;
  /** First line of the gap before anything was loaded. */
  start: number;
  /** Last line of the gap; null past the last hunk until the file end is known. */
  end: number | null;
  head: DiffLineRange | null;
  tail: DiffLineRange | null;
  /** Lines still hidden; null while the gap runs to an unknown end of file. */
  hiddenCount: number | null;
  /** What each affordance requests, or null when it isn't offered. */
  expandDown: DiffLineRange | null;
  expandUp: DiffLineRange | null;
  expandAll: DiffLineRange | null;
}

export function hasDiffContextAffordances(gap: DiffContextGap): boolean {
  return gap.expandDown !== null || gap.expandUp !== null || gap.expandAll !== null;
}

/**
 * Identity of a file's expansion state. It folds in the hunk geometry so a diff
 * that changed underneath — a new commit, a different comparison — starts from a
 * clean slate instead of drawing context that no longer lines up.
 */
export function buildDiffContextFileKey(input: {
  path: string;
  hunks: readonly Pick<DiffHunk, "oldStart" | "oldCount" | "newStart" | "newCount">[];
}): string {
  const geometry = input.hunks
    .map((hunk) => `${hunk.oldStart},${hunk.oldCount},${hunk.newStart},${hunk.newCount}`)
    .join("|");
  return `${input.path}@${geometry}`;
}

function clampBlock(
  block: DiffLineRange | null | undefined,
  start: number,
  end: number | null,
): DiffLineRange | null {
  if (!block) {
    return null;
  }
  const startLine = Math.max(block.startLine, start);
  const endLine = end === null ? block.endLine : Math.min(block.endLine, end);
  return endLine >= startLine ? { startLine, endLine } : null;
}

function buildGap(input: {
  kind: DiffGapKind;
  start: number;
  end: number | null;
  blocks: DiffGapBlocks | undefined;
}): DiffContextGap {
  const { kind, start, end } = input;
  const head = clampBlock(input.blocks?.head, start, end);
  const tail = clampBlock(input.blocks?.tail, start, end);
  const hiddenStart = head ? head.endLine + 1 : start;
  const hiddenEnd = tail ? tail.startLine - 1 : end;
  const hiddenCount = hiddenEnd === null ? null : Math.max(0, hiddenEnd - hiddenStart + 1);

  const base = {
    id: `${kind}:${start}`,
    kind,
    start,
    end,
    head,
    tail,
    hiddenCount,
  };

  if (hiddenCount === 0) {
    return { ...base, expandDown: null, expandUp: null, expandAll: null };
  }
  // A gap the step would swallow whole gets one control rather than three that
  // all do the same thing.
  if (hiddenCount !== null && hiddenEnd !== null && hiddenCount <= DIFF_CONTEXT_EXPAND_STEP) {
    return {
      ...base,
      expandDown: null,
      expandUp: null,
      expandAll: { startLine: hiddenStart, endLine: hiddenEnd },
    };
  }

  const stepDownEnd = hiddenStart + DIFF_CONTEXT_EXPAND_STEP - 1;
  return {
    ...base,
    // Nothing sits above the leading gap, so it only grows upwards from the hunk below.
    expandDown:
      kind === "leading"
        ? null
        : {
            startLine: hiddenStart,
            endLine: hiddenEnd === null ? stepDownEnd : Math.min(stepDownEnd, hiddenEnd),
          },
    expandUp:
      kind === "trailing" || hiddenEnd === null
        ? null
        : {
            startLine: Math.max(hiddenStart, hiddenEnd - DIFF_CONTEXT_EXPAND_STEP + 1),
            endLine: hiddenEnd,
          },
    expandAll: {
      startLine: hiddenStart,
      endLine: hiddenEnd ?? hiddenStart + DIFF_CONTEXT_EXPAND_ALL_LIMIT - 1,
    },
  };
}

/**
 * The gaps of a file, always derived from the ORIGINAL hunks so gap ids stay
 * stable however much has already been loaded into them.
 */
export function computeDiffContextGaps(input: {
  hunks: readonly Pick<DiffHunk, "oldStart" | "oldCount" | "newStart" | "newCount">[];
  state?: DiffFileContextState;
}): DiffContextGap[] {
  const { hunks } = input;
  if (hunks.length === 0) {
    return [];
  }
  const state = input.state ?? EMPTY_DIFF_FILE_CONTEXT_STATE;
  const gaps: DiffContextGap[] = [];

  const push = (kind: DiffGapKind, start: number, end: number | null): void => {
    if (end !== null && end < start) {
      return;
    }
    gaps.push(buildGap({ kind, start, end, blocks: state.blocksByGapId[`${kind}:${start}`] }));
  };

  push("leading", 1, hunks[0].newStart - 1);
  for (let index = 0; index < hunks.length - 1; index += 1) {
    const previous = hunks[index];
    push("between", previous.newStart + previous.newCount, hunks[index + 1].newStart - 1);
  }
  const last = hunks[hunks.length - 1];
  push("trailing", last.newStart + last.newCount, state.fileLineCount);

  return gaps;
}

/** The slice of a `checkout.diff.context` response this module needs. */
export interface DiffContextResponseSlice {
  startLine: number;
  lines: readonly string[];
  reachedEnd: boolean;
}

/** A response that ran off the end of the file has just measured it. */
function resolveFileLineCount(input: {
  reachedEnd: boolean;
  loadedCount: number;
  loadedEnd: number;
  known: number | null;
}): number | null {
  if (!input.reachedEnd) {
    return input.known;
  }
  return input.loadedCount === 0 ? 0 : input.loadedEnd;
}

/**
 * Folds a response into the file's state. The direction that was clicked decides
 * which block grows — the response alone can't say, since a bounded gap can be
 * fed from either end.
 */
export function applyLoadedDiffContext(input: {
  state: DiffFileContextState;
  gap: DiffContextGap;
  direction: DiffContextDirection;
  response: DiffContextResponseSlice;
}): DiffFileContextState {
  const { state, gap, direction, response } = input;
  const loadedCount = response.lines.length;
  const loadedStart = response.startLine;
  const loadedEnd = loadedStart + loadedCount - 1;

  const fileLineCount = resolveFileLineCount({
    reachedEnd: response.reachedEnd,
    loadedCount,
    loadedEnd,
    known: state.fileLineCount,
  });

  if (loadedCount === 0) {
    return { ...state, fileLineCount };
  }

  const linesByNumber = new Map(state.linesByNumber);
  for (const [offset, text] of response.lines.entries()) {
    linesByNumber.set(loadedStart + offset, text);
  }

  const existing = state.blocksByGapId[gap.id] ?? { head: null, tail: null };
  let head = existing.head;
  let tail = existing.tail;
  // The leading gap has no hunk above it to hang a head block on, so everything
  // loaded there — including "expand all" — grows upwards from the hunk below.
  if (direction === "up" || gap.kind === "leading") {
    tail = {
      startLine: Math.min(tail?.startLine ?? loadedStart, loadedStart),
      endLine: Math.max(tail?.endLine ?? loadedEnd, loadedEnd),
    };
  } else {
    head = {
      startLine: Math.min(head?.startLine ?? loadedStart, loadedStart),
      endLine: Math.max(head?.endLine ?? loadedEnd, loadedEnd),
    };
  }
  // The two blocks met: from here the gap is one contiguous run of context.
  if (head && tail && head.endLine + 1 >= tail.startLine) {
    head = { startLine: head.startLine, endLine: Math.max(head.endLine, tail.endLine) };
    tail = null;
  }

  return {
    blocksByGapId: { ...state.blocksByGapId, [gap.id]: { head, tail } },
    linesByNumber,
    fileLineCount,
  };
}

export interface MergedDiffHunks {
  hunks: DiffHunk[];
  /**
   * Per merged hunk, the gap whose expander replaces its `@@` header row. Null
   * keeps the plain header (no gap, or a gap with nothing left to show).
   */
  gapIdByHunkIndex: (string | null)[];
  /** Gap for the expander rendered after the last hunk, or null. */
  trailingGapId: string | null;
}

function buildContextLines(
  block: DiffLineRange,
  linesByNumber: ReadonlyMap<number, string>,
): DiffLine[] {
  const lines: DiffLine[] = [];
  for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
    // Context lines carry a leading space marker, the same shape git emits — the
    // renderer strips it back off. Loaded lines have no syntax tokens; the daemon
    // returns plain text for them.
    lines.push({ type: "context", content: ` ${linesByNumber.get(lineNumber) ?? ""}` });
  }
  return lines;
}

function extendHunk(hunk: DiffHunk | undefined, lines: DiffLine[]): void {
  if (!hunk || lines.length === 0) {
    return;
  }
  hunk.lines = [...hunk.lines, ...lines];
  hunk.oldCount += lines.length;
  hunk.newCount += lines.length;
}

/**
 * Rebuilds the hunk list with everything loaded so far folded in as context.
 *
 * The head block of a gap extends the hunk above it, the tail block extends the
 * hunk below it, and a gap that has been closed entirely joins the two hunks
 * into one. Line numbers follow from the hunk bounds, so the existing numbering
 * pass gives the loaded lines their old and new numbers for free.
 */
export function mergeLoadedDiffContext(input: {
  hunks: readonly DiffHunk[];
  gaps: readonly DiffContextGap[];
  state: DiffFileContextState;
}): MergedDiffHunks {
  const { hunks, gaps, state } = input;
  const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
  const merged: DiffHunk[] = [];
  const gapIdByHunkIndex: (string | null)[] = [];

  const gapBefore = (hunkIndex: number): DiffContextGap | null => {
    if (hunkIndex === 0) {
      return gapById.get("leading:1") ?? null;
    }
    const previous = hunks[hunkIndex - 1];
    return gapById.get(`between:${previous.newStart + previous.newCount}`) ?? null;
  };

  const blockLines = (block: DiffLineRange | null | undefined): DiffLine[] =>
    block ? buildContextLines(block, state.linesByNumber) : [];

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const gap = gapBefore(hunkIndex);
    const isClosed = gap !== null && gap.hiddenCount === 0;
    const current = merged[merged.length - 1];

    extendHunk(current, blockLines(gap?.head));

    if (hunkIndex > 0 && isClosed && current) {
      // The gap is gone: this hunk continues the one above it, header and all.
      // A gap closed from below holds its lines in the tail block, which is now
      // just as contiguous with the hunk above as a head block would be.
      extendHunk(current, blockLines(gap?.tail));
      current.lines = [...current.lines, ...hunk.lines.filter((line) => line.type !== "header")];
      current.oldCount += hunk.oldCount;
      current.newCount += hunk.newCount;
      continue;
    }

    const tailLines = blockLines(gap?.tail);
    // The leading gap's header row is the top of the file once nothing is elided.
    const dropHeader = hunkIndex === 0 && isClosed;
    const headerLines = dropHeader ? [] : hunk.lines.filter((line) => line.type === "header");
    const bodyLines = hunk.lines.filter((line) => line.type !== "header");

    merged.push({
      oldStart: hunk.oldStart - tailLines.length,
      oldCount: hunk.oldCount + tailLines.length,
      newStart: hunk.newStart - tailLines.length,
      newCount: hunk.newCount + tailLines.length,
      lines: [...headerLines, ...tailLines, ...bodyLines],
    });
    gapIdByHunkIndex.push(gap && !dropHeader && hasDiffContextAffordances(gap) ? gap.id : null);
  }

  const trailingGap = gaps.find((gap) => gap.kind === "trailing") ?? null;
  extendHunk(merged[merged.length - 1], blockLines(trailingGap?.head));

  return {
    hunks: merged,
    gapIdByHunkIndex,
    trailingGapId: trailingGap && hasDiffContextAffordances(trailingGap) ? trailingGap.id : null,
  };
}
