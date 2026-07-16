import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { DiffLine } from "@/git/use-diff-query";
import { computeWordChangeRanges, type WordChangeRange } from "@/utils/diff-word-highlight";

type ReviewSide = "old" | "new";

// The code on a diff line is its content with the leading +/-/space marker
// removed — the same coordinate space the syntax tokens and word-change ranges
// use.
function stripDiffMarker(line: DiffLine): string {
  const { content, type } = line;
  if (type === "add" || type === "remove") {
    return content.startsWith(type === "add" ? "+" : "-") ? content.slice(1) : content;
  }
  if (type === "context") {
    return content.startsWith(" ") ? content.slice(1) : content;
  }
  return content;
}
type ReviewableLineType = "add" | "remove" | "context";

export interface ReviewableDiffTargetKeyInput {
  filePath: string;
  side: ReviewSide;
  lineNumber: number;
}

export interface ReviewableDiffTarget {
  key: string;
  filePath: string;
  hunkHeader: string;
  hunkIndex: number;
  lineIndex: number;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  side: ReviewSide;
  lineNumber: number;
  lineType: ReviewableLineType;
  content: string;
}

export function buildReviewableDiffTargetKey(input: ReviewableDiffTargetKeyInput): string {
  return `${input.filePath}:${input.side}:${input.lineNumber}`;
}

export interface NumberedDiffCell extends ReviewableDiffTarget {
  line: DiffLine;
  // Intra-line (word-level) changed char ranges, in code coordinate space, for
  // this cell's side. Present only on removed/added lines that form a partial
  // edit against their paired counterpart.
  changedRanges?: WordChangeRange[];
}

export interface NumberedDiffLine {
  key: string;
  filePath: string;
  hunkHeader: string;
  hunkIndex: number;
  lineIndex: number;
  line: DiffLine;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  unifiedCell: NumberedDiffCell | null;
  oldCell: NumberedDiffCell | null;
  newCell: NumberedDiffCell | null;
}

export interface NumberedDiffHunk {
  hunkIndex: number;
  hunkHeader: string;
  lines: NumberedDiffLine[];
}

export interface SplitDiffDisplayLine {
  type: DiffLine["type"];
  content: string;
  tokens?: DiffLine["tokens"];
  changedRanges?: WordChangeRange[];
  lineNumber: number | null;
  reviewTarget: ReviewableDiffTarget | null;
}

export interface UnifiedDiffDisplayLine {
  key: string;
  line: DiffLine;
  changedRanges?: WordChangeRange[];
  lineNumber: number | null;
  reviewTarget: ReviewableDiffTarget | null;
}

export type SplitDiffRow =
  | {
      kind: "header";
      content: string;
    }
  | {
      kind: "pair";
      left: SplitDiffDisplayLine | null;
      right: SplitDiffDisplayLine | null;
    };

function toSplitDisplayLine(cell: NumberedDiffCell | null): SplitDiffDisplayLine | null {
  if (!cell) {
    return null;
  }

  return {
    type: cell.lineType,
    content: cell.content,
    ...(cell.line.tokens ? { tokens: cell.line.tokens } : {}),
    ...(cell.changedRanges ? { changedRanges: cell.changedRanges } : {}),
    lineNumber: cell.lineNumber,
    reviewTarget: toReviewTarget(cell),
  };
}

function toReviewTarget(cell: NumberedDiffCell): ReviewableDiffTarget {
  return {
    key: cell.key,
    filePath: cell.filePath,
    hunkHeader: cell.hunkHeader,
    hunkIndex: cell.hunkIndex,
    lineIndex: cell.lineIndex,
    oldLineNumber: cell.oldLineNumber,
    newLineNumber: cell.newLineNumber,
    side: cell.side,
    lineNumber: cell.lineNumber,
    lineType: cell.lineType,
    content: cell.content,
  };
}

function getHunkHeader(hunk: ParsedDiffFile["hunks"][number]): string {
  const headerLine = hunk.lines.find((line) => line.type === "header");
  return headerLine?.content ?? "@@";
}

// Pair each run of removed lines with the run of added lines that immediately
// follows it (index-aligned, matching how the split view lays pairs out) and
// compute the word-level changed ranges for both sides. Mutates the cells in
// place. Runs once per hunk during numbering so unified and split share it.
//
// When the server already supplied changedRanges (structural engines like
// difftastic), those are used verbatim — the two sources disagree on semantics
// and mixing them would double-highlight or contradict each other. For files
// produced by difftastic (skipLocalCompute) the local LCS computation is skipped
// entirely: the server owns word ranges there, so pairs where it deliberately
// suppressed whole-line highlights must not fall through to a local guess.
function assignWordChangeRanges(lines: NumberedDiffLine[], skipLocalCompute: boolean): void {
  let removals: NumberedDiffCell[] = [];
  let additions: NumberedDiffCell[] = [];

  const flush = () => {
    const pairCount = Math.min(removals.length, additions.length);
    for (let index = 0; index < pairCount; index += 1) {
      const removal = removals[index];
      const addition = additions[index];
      const serverOldRanges = removal.line.changedRanges;
      const serverNewRanges = addition.line.changedRanges;
      if (serverOldRanges || serverNewRanges) {
        if (serverOldRanges && serverOldRanges.length > 0) {
          removal.changedRanges = serverOldRanges;
        }
        if (serverNewRanges && serverNewRanges.length > 0) {
          addition.changedRanges = serverNewRanges;
        }
        continue;
      }
      if (skipLocalCompute) {
        continue;
      }
      const { oldRanges, newRanges } = computeWordChangeRanges(
        stripDiffMarker(removal.line),
        stripDiffMarker(addition.line),
      );
      if (oldRanges.length > 0) {
        removal.changedRanges = oldRanges;
      }
      if (newRanges.length > 0) {
        addition.changedRanges = newRanges;
      }
    }
    removals = [];
    additions = [];
  };

  for (const numberedLine of lines) {
    const { type } = numberedLine.line;
    if (type === "remove" && numberedLine.oldCell) {
      // An added run followed by another removed run starts a fresh pairing.
      if (additions.length > 0) {
        flush();
      }
      removals.push(numberedLine.oldCell);
    } else if (type === "add" && numberedLine.newCell) {
      additions.push(numberedLine.newCell);
    } else {
      flush();
    }
  }
  flush();
}

export function buildNumberedDiffHunks(file: ParsedDiffFile): NumberedDiffHunk[] {
  const numberedHunks: NumberedDiffHunk[] = [];
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    let oldLineNo = hunk.oldStart;
    let newLineNo = hunk.newStart;
    const hunkHeader = getHunkHeader(hunk);
    const lines: NumberedDiffLine[] = [];

    for (const [lineIndex, line] of hunk.lines.entries()) {
      let oldLineNumber: number | null = null;
      let newLineNumber: number | null = null;

      if (line.type === "remove") {
        oldLineNumber = oldLineNo;
        oldLineNo += 1;
      } else if (line.type === "add") {
        newLineNumber = newLineNo;
        newLineNo += 1;
      } else if (line.type === "context") {
        oldLineNumber = oldLineNo;
        newLineNumber = newLineNo;
        oldLineNo += 1;
        newLineNo += 1;
      }

      const oldCell = buildNumberedCell({
        filePath: file.path,
        hunkHeader,
        hunkIndex,
        lineIndex,
        line,
        oldLineNumber,
        newLineNumber,
        side: "old",
      });
      const newCell = buildNumberedCell({
        filePath: file.path,
        hunkHeader,
        hunkIndex,
        lineIndex,
        line,
        oldLineNumber,
        newLineNumber,
        side: "new",
      });

      lines.push({
        key: `${hunkIndex}-${lineIndex}`,
        filePath: file.path,
        hunkHeader,
        hunkIndex,
        lineIndex,
        line,
        oldLineNumber,
        newLineNumber,
        unifiedCell: line.type === "remove" ? oldCell : newCell,
        oldCell,
        newCell,
      });
    }

    assignWordChangeRanges(lines, file.diffTool === "difftastic");
    numberedHunks.push({ hunkIndex, hunkHeader, lines });
  }

  return numberedHunks;
}

function buildNumberedCell(input: {
  filePath: string;
  hunkHeader: string;
  hunkIndex: number;
  lineIndex: number;
  line: DiffLine;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  side: ReviewSide;
}): NumberedDiffCell | null {
  if (input.line.type === "header") {
    return null;
  }
  if (input.line.type === "remove" && input.side !== "old") {
    return null;
  }
  if (input.line.type === "add" && input.side !== "new") {
    return null;
  }

  const lineNumber = input.side === "old" ? input.oldLineNumber : input.newLineNumber;
  if (lineNumber === null) {
    return null;
  }

  return {
    key: buildReviewableDiffTargetKey({
      filePath: input.filePath,
      side: input.side,
      lineNumber,
    }),
    filePath: input.filePath,
    hunkHeader: input.hunkHeader,
    hunkIndex: input.hunkIndex,
    lineIndex: input.lineIndex,
    oldLineNumber: input.oldLineNumber,
    newLineNumber: input.newLineNumber,
    side: input.side,
    lineNumber,
    lineType: input.line.type,
    content: input.line.content,
    line: input.line,
  };
}

export function buildUnifiedDiffLines(file: ParsedDiffFile): UnifiedDiffDisplayLine[] {
  return buildNumberedDiffHunks(file).flatMap((hunk) =>
    hunk.lines.map((numberedLine) => ({
      key: numberedLine.key,
      line: numberedLine.line,
      ...(numberedLine.unifiedCell?.changedRanges
        ? { changedRanges: numberedLine.unifiedCell.changedRanges }
        : {}),
      lineNumber: numberedLine.unifiedCell?.lineNumber ?? null,
      reviewTarget: numberedLine.unifiedCell ? toReviewTarget(numberedLine.unifiedCell) : null,
    })),
  );
}

export function buildSplitDiffRows(file: ParsedDiffFile): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];

  for (const hunk of buildNumberedDiffHunks(file)) {
    rows.push({
      kind: "header",
      content: hunk.hunkHeader,
    });

    let pendingRemovals: NumberedDiffCell[] = [];
    let pendingAdditions: NumberedDiffCell[] = [];

    const flushPendingRows = () => {
      const pairCount = Math.max(pendingRemovals.length, pendingAdditions.length);
      for (let index = 0; index < pairCount; index += 1) {
        const removal = pendingRemovals[index] ?? null;
        const addition = pendingAdditions[index] ?? null;
        rows.push({
          kind: "pair",
          left: toSplitDisplayLine(removal),
          right: toSplitDisplayLine(addition),
        });
      }
      pendingRemovals = [];
      pendingAdditions = [];
    };

    for (const numberedLine of hunk.lines) {
      if (numberedLine.line.type === "header") {
        continue;
      }

      if (numberedLine.line.type === "remove") {
        if (numberedLine.oldCell) {
          pendingRemovals.push(numberedLine.oldCell);
        }
        continue;
      }

      if (numberedLine.line.type === "add") {
        if (numberedLine.newCell) {
          pendingAdditions.push(numberedLine.newCell);
        }
        continue;
      }

      flushPendingRows();

      if (numberedLine.line.type === "context") {
        rows.push({
          kind: "pair",
          left: toSplitDisplayLine(numberedLine.oldCell),
          right: toSplitDisplayLine(numberedLine.newCell),
        });
      }
    }

    flushPendingRows();
  }

  return rows;
}
