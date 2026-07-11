import {
  DefaultLinesDiffComputer,
  type DetailedLineRangeMapping,
  type RangeMapping,
} from "vscode-diff";

import type { DiffHunk, DiffLine, ParsedDiffFile } from "../server/utils/diff-highlighter.js";

// git default: 3 context lines around each hunk (matches difftastic.ts convention).
const HUNK_CONTEXT_LINES = 3;
// Engine version for mapper-result cache keys. Bump alongside the vscode-diff
// dependency in package.json — different package versions may diff differently.
export const VSCODE_DIFF_PACKAGE_VERSION = "3.0.1";
// "~1000" per the technical plan — generous enough for large files while still
// bounding worst-case latency; caller can override per invocation.
const DEFAULT_MAX_COMPUTATION_TIME_MS = 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VscodeDiffErrorCode = "timeout";

// hitTimeout means vscode-diff returned a partial/approximate result — not a
// usable diff. Caller should fall back to another engine (e.g. git).
export class VscodeDiffTimeoutError extends Error {
  readonly code: VscodeDiffErrorCode = "timeout";

  constructor(path: string) {
    super(`vscode-diff hit maxComputationTimeMs for "${path}" — partial result discarded`);
    this.name = "VscodeDiffTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WordChangeRange {
  start: number;
  end: number;
}

export interface VscodeDiffLine extends DiffLine {
  // Char-column (UTF-16 code unit) ranges. vscode-diff's innerChanges columns
  // are already UTF-16 code units — the same coordinate space JS strings use —
  // so no byte/char conversion is needed here (unlike difftastic's UTF-8
  // byte offsets).
  changedRanges?: WordChangeRange[];
}

export interface VscodeDiffHunk extends DiffHunk {
  lines: VscodeDiffLine[];
}

export interface VscodeDiffParsedFile extends ParsedDiffFile {
  hunks: VscodeDiffHunk[];
}

export interface VscodeDiffOptions {
  ignoreTrimWhitespace?: boolean;
  maxComputationTimeMs?: number;
}

// Structural shape shared by vscode-diff's Range/LineRange classes for the
// fields we read. Declared locally (rather than imported) because "Range" is
// not part of the package's public export surface — only DetailedLineRangeMapping
// and RangeMapping are re-exported from the package root.
interface ColumnRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

// ---------------------------------------------------------------------------
// Line splitting
// ---------------------------------------------------------------------------

// Split blob text into lines the way vscode's text model does: an empty
// document is still one (empty) line, not zero lines (probe.js verified this
// for the pure add/delete case: empty side = ['']). A single trailing
// newline is treated as terminating the last line, not starting a new one.
function splitBlobLines(text: string): string[] {
  if (text === "") return [""];
  return text.replace(/\n$/, "").split("\n");
}

// ---------------------------------------------------------------------------
// Whole-file synthesis (pure created/deleted content)
// ---------------------------------------------------------------------------

function synthesizeWholeFileHunk(
  path: string,
  content: string,
  lineType: "add" | "remove",
): VscodeDiffParsedFile {
  const lines = splitBlobLines(content);
  // A genuinely empty file (0 bytes) has no lines to render.
  const isEmptyFile = lines.length === 1 && lines[0] === "";
  const diffLines: VscodeDiffLine[] = isEmptyFile
    ? []
    : lines.map((lineContent) => ({ type: lineType, content: lineContent }));
  const count = diffLines.length;

  const oldStart = lineType === "remove" ? 1 : 0;
  const oldCount = lineType === "remove" ? count : 0;
  const newStart = lineType === "add" ? 1 : 0;
  const newCount = lineType === "add" ? count : 0;

  const hunks: VscodeDiffHunk[] =
    count === 0
      ? []
      : [
          {
            oldStart,
            oldCount,
            newStart,
            newCount,
            lines: [
              {
                type: "header",
                content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
              },
              ...diffLines,
            ],
          },
        ];

  return {
    path,
    isNew: lineType === "add",
    isDeleted: lineType === "remove",
    additions: lineType === "add" ? count : 0,
    deletions: lineType === "remove" ? count : 0,
    hunks,
  };
}

// ---------------------------------------------------------------------------
// Inner-change (word-level) range mapping
// ---------------------------------------------------------------------------

function pushRange(
  map: Map<number, WordChangeRange[]>,
  lineNumber: number,
  start: number,
  end: number,
): void {
  if (end <= start) return; // zero-width insertion point — nothing to highlight
  const entry = { start, end };
  const existing = map.get(lineNumber);
  if (existing) {
    existing.push(entry);
  } else {
    map.set(lineNumber, [entry]);
  }
}

// A RangeMapping's original/modified Range can in principle span multiple
// lines (e.g. a changed span that swallows a newline). Split it into one
// entry per covered line: first line from its start column to EOL, middle
// lines fully covered, last line from column 1 to its end column.
function addRangeSpan(
  map: Map<number, WordChangeRange[]>,
  range: ColumnRange,
  lines: string[],
): void {
  if (range.startLineNumber === range.endLineNumber) {
    pushRange(map, range.startLineNumber, range.startColumn - 1, range.endColumn - 1);
    return;
  }

  const firstLineText = lines[range.startLineNumber - 1] ?? "";
  pushRange(map, range.startLineNumber, range.startColumn - 1, firstLineText.length);
  for (let lineNumber = range.startLineNumber + 1; lineNumber < range.endLineNumber; lineNumber++) {
    const text = lines[lineNumber - 1] ?? "";
    pushRange(map, lineNumber, 0, text.length);
  }
  pushRange(map, range.endLineNumber, 0, range.endColumn - 1);
}

function buildLineRangeMap(
  innerChanges: readonly RangeMapping[] | undefined,
  side: "original" | "modified",
  lines: string[],
): Map<number, WordChangeRange[]> {
  const map = new Map<number, WordChangeRange[]>();
  if (!innerChanges) return map;
  for (const mapping of innerChanges) {
    const range: ColumnRange = side === "original" ? mapping.originalRange : mapping.modifiedRange;
    addRangeSpan(map, range, lines);
  }
  return map;
}

function mergeRanges(ranges: WordChangeRange[]): WordChangeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: WordChangeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

// Whole-line suppression, mirroring the app's computeWordChangeRanges/isWholeLine
// (packages/app/src/utils/diff-word-highlight.ts): when a line's changed
// ranges cover it end to end, the solid line tint already reads as "fully
// changed" — a second full-width intra-line layer is redundant noise. This
// matters most for freshly-inserted lines, where vscode-diff's innerChanges
// legitimately cover the whole new line.
function filterWholeLineRanges(
  content: string,
  ranges: WordChangeRange[] | undefined,
): WordChangeRange[] | undefined {
  if (!ranges || ranges.length === 0) return undefined;
  const merged = mergeRanges(ranges);
  const isWholeLine =
    merged.length === 1 && merged[0].start === 0 && merged[0].end === content.length;
  return isWholeLine ? undefined : merged;
}

// ---------------------------------------------------------------------------
// Hunk construction
// ---------------------------------------------------------------------------

// Merge changes into hunks whenever their ±HUNK_CONTEXT_LINES context windows
// touch or overlap, so adjacent edits share one printed context region
// instead of duplicating it across two hunks (mirrors git's hunk merging).
function groupChangesIntoHunks(
  changes: readonly DetailedLineRangeMapping[],
): DetailedLineRangeMapping[][] {
  const groups: DetailedLineRangeMapping[][] = [];
  let current: DetailedLineRangeMapping[] = [];

  for (const change of changes) {
    if (current.length === 0) {
      current.push(change);
      continue;
    }
    const prev = current[current.length - 1];
    const gap = change.original.startLineNumber - prev.original.endLineNumberExclusive;
    if (gap <= HUNK_CONTEXT_LINES * 2) {
      current.push(change);
    } else {
      groups.push(current);
      current = [change];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildHunk(
  group: DetailedLineRangeMapping[],
  originalLines: string[],
  modifiedLines: string[],
): VscodeDiffHunk {
  const first = group[0];
  const last = group[group.length - 1];

  // Between changes (and around the group) the two sides are unchanged, so a
  // given original line number maps to modified = original + offset, where
  // offset is constant across that unchanged stretch.
  const offsetBefore = first.modified.startLineNumber - first.original.startLineNumber;
  const offsetAfter = last.modified.endLineNumberExclusive - last.original.endLineNumberExclusive;

  const hunkOrigStart = Math.max(1, first.original.startLineNumber - HUNK_CONTEXT_LINES);
  const hunkOrigEnd = Math.min(
    originalLines.length + 1,
    last.original.endLineNumberExclusive + HUNK_CONTEXT_LINES,
  );
  const hunkModStart = Math.max(1, hunkOrigStart + offsetBefore);
  const hunkModEnd = Math.min(modifiedLines.length + 1, hunkOrigEnd + offsetAfter);

  const lines: VscodeDiffLine[] = [
    {
      type: "header",
      content: `@@ -${hunkOrigStart},${hunkOrigEnd - hunkOrigStart} +${hunkModStart},${hunkModEnd - hunkModStart} @@`,
    },
  ];

  let cursorOrig = hunkOrigStart;

  const pushContext = (uptoOrig: number): void => {
    while (cursorOrig < uptoOrig) {
      lines.push({ type: "context", content: originalLines[cursorOrig - 1] });
      cursorOrig++;
    }
  };

  for (const change of group) {
    pushContext(change.original.startLineNumber);

    const originalRangeMap = buildLineRangeMap(change.innerChanges, "original", originalLines);
    const modifiedRangeMap = buildLineRangeMap(change.innerChanges, "modified", modifiedLines);

    for (
      let lineNumber = change.original.startLineNumber;
      lineNumber < change.original.endLineNumberExclusive;
      lineNumber++
    ) {
      const content = originalLines[lineNumber - 1];
      const changedRanges = filterWholeLineRanges(content, originalRangeMap.get(lineNumber));
      lines.push({ type: "remove", content, ...(changedRanges ? { changedRanges } : {}) });
    }
    for (
      let lineNumber = change.modified.startLineNumber;
      lineNumber < change.modified.endLineNumberExclusive;
      lineNumber++
    ) {
      const content = modifiedLines[lineNumber - 1];
      const changedRanges = filterWholeLineRanges(content, modifiedRangeMap.get(lineNumber));
      lines.push({ type: "add", content, ...(changedRanges ? { changedRanges } : {}) });
    }

    cursorOrig = change.original.endLineNumberExclusive;
  }

  pushContext(hunkOrigEnd);

  return {
    oldStart: hunkOrigStart,
    oldCount: hunkOrigEnd - hunkOrigStart,
    newStart: hunkModStart,
    newCount: hunkModEnd - hunkModStart,
    lines,
  };
}

function mapChangesToParsedDiff(
  path: string,
  originalLines: string[],
  modifiedLines: string[],
  changes: readonly DetailedLineRangeMapping[],
): VscodeDiffParsedFile {
  if (changes.length === 0) {
    return { path, isNew: false, isDeleted: false, additions: 0, deletions: 0, hunks: [] };
  }

  const groups = groupChangesIntoHunks(changes);
  const hunks: VscodeDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;

  for (const group of groups) {
    const hunk = buildHunk(group, originalLines, modifiedLines);
    hunks.push(hunk);
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      else if (line.type === "remove") deletions++;
    }
  }

  return { path, isNew: false, isDeleted: false, additions, deletions, hunks };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Compute a diff for one file's old/new content using vscode's in-process
// DefaultLinesDiffComputer (the same algorithm VS Code's editor uses),
// mapped into the ParsedDiffFile shape diff-highlighter.ts's parseDiff()
// produces from unified diff text, so downstream syntax highlighting and
// rendering apply unchanged.
//
// `oldContent`/`newContent` are `null` for created/deleted files respectively
// — those bypass the diff algorithm entirely and synthesize a single
// whole-file hunk (this engine can represent created/deleted content,
// unlike a text-diff-only tool). Passing `null` for both is a caller error.
//
// v1 simplification: `result.moves` (vscode-diff's move-detection metadata)
// is intentionally ignored. `result.changes` already represents a move as a
// plain delete block + insert block (verified against probe.js), which is
// exactly the "render as plain add/remove" behavior the plan calls for — no
// special-casing needed to get that outcome.
export function computeVscodeDiffFile(
  path: string,
  oldContent: string | null,
  newContent: string | null,
  options: VscodeDiffOptions = {},
): VscodeDiffParsedFile {
  if (oldContent === null && newContent === null) {
    throw new Error(
      "computeVscodeDiffFile: at least one of oldContent/newContent must be non-null",
    );
  }

  if (oldContent === null) {
    return synthesizeWholeFileHunk(path, newContent as string, "add");
  }
  if (newContent === null) {
    return synthesizeWholeFileHunk(path, oldContent, "remove");
  }

  if (oldContent === newContent) {
    return { path, isNew: false, isDeleted: false, additions: 0, deletions: 0, hunks: [] };
  }

  const originalLines = splitBlobLines(oldContent);
  const modifiedLines = splitBlobLines(newContent);

  const computer = new DefaultLinesDiffComputer();
  const result = computer.computeDiff(originalLines, modifiedLines, {
    ignoreTrimWhitespace: options.ignoreTrimWhitespace ?? false,
    maxComputationTimeMs: options.maxComputationTimeMs ?? DEFAULT_MAX_COMPUTATION_TIME_MS,
    computeMoves: true,
  });

  if (result.hitTimeout) {
    throw new VscodeDiffTimeoutError(path);
  }

  return mapChangesToParsedDiff(path, originalLines, modifiedLines, result.changes);
}
