import { computeWordLevelDiff } from "@/utils/tool-call-parsers";

// Half-open char range [start, end) into a diff line's CODE text (the content
// with its leading +/- marker already stripped), marking the span the
// word-level diff considers changed relative to its paired counterpart line.
export interface WordChangeRange {
  start: number;
  end: number;
}

// Guard against pathological lines: the LCS is O(words²), and very long lines
// (minified bundles, data blobs) blow up both compute and the number of spans
// we'd render. Above this the caller keeps the whole-line tint instead — a
// performance fallback, not a feature toggle.
const MAX_WORD_DIFF_LINE_LENGTH = 400;

// Compute the changed char ranges for a paired removed/added line. `oldCode` and
// `newCode` are the CODE text (no +/- prefix). Returns empty ranges when either
// line is too long (fall back to whole-line highlight) or when the pair is not a
// partial edit (identical, or a full replacement with nothing in common) — in
// those cases per-word emphasis adds noise rather than signal.
export function computeWordChangeRanges(
  oldCode: string,
  newCode: string,
): { oldRanges: WordChangeRange[]; newRanges: WordChangeRange[] } {
  if (
    oldCode.length === 0 ||
    newCode.length === 0 ||
    oldCode.length > MAX_WORD_DIFF_LINE_LENGTH ||
    newCode.length > MAX_WORD_DIFF_LINE_LENGTH ||
    oldCode === newCode
  ) {
    return { oldRanges: [], newRanges: [] };
  }

  const { oldSegments, newSegments } = computeWordLevelDiff(oldCode, newCode);

  const toRanges = (segments: { text: string; changed: boolean }[]): WordChangeRange[] => {
    const ranges: WordChangeRange[] = [];
    let offset = 0;
    for (const segment of segments) {
      const end = offset + segment.text.length;
      if (segment.changed && segment.text.length > 0) {
        ranges.push({ start: offset, end });
      }
      offset = end;
    }
    return ranges;
  };

  const oldRanges = toRanges(oldSegments);
  const newRanges = toRanges(newSegments);

  // Whole-line change (every segment changed) reads better as the existing
  // solid line tint; drop the intra-line layer so it doesn't paint the entire
  // line a second, darker shade.
  const isWholeLine = (code: string, ranges: WordChangeRange[]): boolean =>
    ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === code.length;
  if (isWholeLine(oldCode, oldRanges) && isWholeLine(newCode, newRanges)) {
    return { oldRanges: [], newRanges: [] };
  }

  return { oldRanges, newRanges };
}

export interface TokenLike<S> {
  text: string;
  style: S;
}

export interface WordHighlightPiece<S> {
  text: string;
  style: S;
  changed: boolean;
}

// Split syntax-highlight tokens at the changed-range boundaries so each emitted
// piece is uniformly changed or unchanged while keeping its original syntax
// style. Char offsets track position across the concatenated token text, which
// matches the CODE coordinate space `changedRanges` is expressed in. Generic
// over the token's `style` type so it works with both the highlighter's
// `HighlightStyle` and the protocol's wider `string` style.
export function splitTokensByChangeRanges<S>(
  tokens: TokenLike<S>[],
  changedRanges: WordChangeRange[],
): WordHighlightPiece<S>[] {
  if (changedRanges.length === 0) {
    return tokens.map((token) => ({ text: token.text, style: token.style, changed: false }));
  }

  const pieces: WordHighlightPiece<S>[] = [];
  let offset = 0;
  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.text.length;
    offset = tokenEnd;
    if (token.text.length === 0) {
      continue;
    }

    // Collect the cut points inside this token from ranges that overlap it.
    const cuts = new Set<number>([0, token.text.length]);
    for (const range of changedRanges) {
      if (range.end <= tokenStart || range.start >= tokenEnd) {
        continue;
      }
      cuts.add(Math.max(0, range.start - tokenStart));
      cuts.add(Math.min(token.text.length, range.end - tokenStart));
    }
    const sortedCuts = Array.from(cuts).sort((a, b) => a - b);

    for (let i = 0; i < sortedCuts.length - 1; i += 1) {
      const pieceStart = sortedCuts[i];
      const pieceEnd = sortedCuts[i + 1];
      if (pieceEnd <= pieceStart) {
        continue;
      }
      const absoluteStart = tokenStart + pieceStart;
      const midpoint = absoluteStart + (pieceEnd - pieceStart) / 2;
      const changed = changedRanges.some((range) => midpoint > range.start && midpoint < range.end);
      pieces.push({
        text: token.text.slice(pieceStart, pieceEnd),
        style: token.style,
        changed,
      });
    }
  }
  return pieces;
}
