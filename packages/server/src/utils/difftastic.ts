import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { resolvePaseoHome } from "../server/paseo-home.js";
import type { DiffHunk, DiffLine, ParsedDiffFile } from "../server/utils/diff-highlighter.js";

const execFileAsync = promisify(execFile);

// `difft --display json` landed in difftastic 0.51.0 (CHANGELOG "0.51.0
// (released 25th August 2023)": "Added a JSON display option"). Anything older
// cannot produce machine-readable output, so we treat it as not installed.
export const MIN_DIFFT_JSON_VERSION = "0.51.0";

export const DIFFT_MAX_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
// git default: 3 context lines around each hunk.
const HUNK_CONTEXT_LINES = 3;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DifftasticFallbackReason =
  // File reported as created/deleted (difft judges by content, not existence)
  // or chunks/aligned_lines missing — nothing to map, caller uses git path.
  | "created_or_deleted"
  | "missing_chunks"
  // difft gave up on structural diff (byte/graph limit, parse errors) and
  // fell back to its own line-oriented mode — git's line diff is better/cheaper.
  | "text_fallback"
  // difft says "unchanged" (structural equivalence, e.g. whitespace-only or
  // conflict-marker files) but the blobs differ byte-wise — git must decide.
  | "unchanged_mismatch";

// Expected "this file can't go through difftastic" signal. Caller routes the
// file to the git diff path silently.
export class DifftasticNotMappableError extends Error {
  readonly reason: DifftasticFallbackReason;

  constructor(reason: DifftasticFallbackReason, message: string) {
    super(message);
    this.name = "DifftasticNotMappableError";
    this.reason = reason;
  }
}

export type DifftasticErrorCode =
  | "spawn_failed"
  | "timeout"
  | "stdout_limit"
  | "exit_error"
  // stdout not valid JSON. Also covers the "set DFT_UNSTABLE=yes" hint text
  // difft prints when the env var is missing.
  | "invalid_json"
  // JSON parsed but the shape does not match what we know of difft's schema
  // (DFT_UNSTABLE schema drift, defensive parsing).
  | "invalid_shape";

// Hard failure running or interpreting difftastic. Caller may still fall back
// to git, but should surface/log it (unlike DifftasticNotMappableError).
export class DifftasticError extends Error {
  readonly code: DifftasticErrorCode;

  constructor(code: DifftasticErrorCode, message: string) {
    super(message);
    this.name = "DifftasticError";
    this.code = code;
  }
}

function shapeError(detail: string): DifftasticError {
  return new DifftasticError("invalid_shape", `Unexpected difftastic JSON shape: ${detail}`);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DifftasticInfo {
  path: string;
  version: string;
}

interface DetectDifftOptions {
  // Custom env bypasses the in-process cache (used by tests and probes).
  env?: NodeJS.ProcessEnv;
}

let detectCache: Promise<DifftasticInfo | null> | null = null;

// Installer calls this after dropping a binary into $PASEO_HOME/bin so the
// next detectDifft() re-probes.
export function invalidateDifftDetection(): void {
  detectCache = null;
}

export function detectDifft(options?: DetectDifftOptions): Promise<DifftasticInfo | null> {
  if (options?.env) {
    return detectDifftUncached(options.env);
  }
  detectCache ??= detectDifftUncached(process.env);
  return detectCache;
}

async function detectDifftUncached(env: NodeJS.ProcessEnv): Promise<DifftasticInfo | null> {
  for (const candidate of candidateDifftPaths(env)) {
    const version = await probeDifftVersion(candidate);
    if (version !== null && isVersionAtLeast(version, MIN_DIFFT_JSON_VERSION)) {
      return { path: candidate, version };
    }
  }
  return null;
}

function* candidateDifftPaths(env: NodeJS.ProcessEnv): Generator<string> {
  const explicit = env.PASEO_DIFFT_PATH?.trim();
  if (explicit) {
    yield explicit;
  }

  const fromPath = findInPath(env);
  if (fromPath) {
    yield fromPath;
  }

  // Auto-install drop point.
  try {
    yield path.join(resolvePaseoHome(env), "bin", difftBinaryName());
  } catch {
    // PASEO_HOME not resolvable/creatable — no managed install to probe.
  }
}

function difftBinaryName(): string {
  return process.platform === "win32" ? "difft.exe" : "difft";
}

function findInPath(env: NodeJS.ProcessEnv): string | null {
  const binary = difftBinaryName();
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function probeDifftVersion(difftPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(difftPath, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const match = stdout.match(/^Difftastic\s+(\d+(?:\.\d+){0,2})/im);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const actual = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < 3; i++) {
    const a = actual[i] ?? 0;
    const b = required[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.capacity) {
      await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

// difft peaks ~1GB RSS on pathological inputs even with a lowered graph
// limit, so the budget is memory-driven, not CPU-driven.
const difftSemaphore = new Semaphore(DIFFT_MAX_CONCURRENCY);

export interface RunDifftJsonOptions {
  difftPath: string;
  // difft has no --time-limit (upstream #814) — external kill only.
  timeoutMs?: number;
  maxStdoutBytes?: number;
  env?: NodeJS.ProcessEnv;
}

// Runs difft on two files and returns the parsed per-file JSON object.
// Two-file mode emits a bare object; directory mode emits an array — accept
// both (single-element array unwrapped).
export async function runDifftJson(
  oldFile: string,
  newFile: string,
  options: RunDifftJsonOptions,
): Promise<Record<string, unknown>> {
  const release = await difftSemaphore.acquire();
  try {
    return await spawnDifftJson(oldFile, newFile, options);
  } finally {
    release();
  }
}

function spawnDifftJson(
  oldFile: string,
  newFile: string,
  options: RunDifftJsonOptions,
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn(
      options.difftPath,
      [
        "--display",
        "json",
        "--strip-cr",
        "on",
        // Default 3e6 peaks ~950MB RSS on 10k-line full rewrites; 1e6 makes
        // difft fall back to its Text mode earlier (we then use git instead).
        "--graph-limit",
        "1000000",
        // Keep default --byte-limit.
        "--",
        oldFile,
        newFile,
      ],
      {
        env: { ...(options.env ?? process.env), DFT_UNSTABLE: "yes" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrText = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new DifftasticError("timeout", `difftastic timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail(
          new DifftasticError("stdout_limit", `difftastic stdout exceeded ${maxStdoutBytes} bytes`),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrText.length < 16_384) {
        stderrText += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      fail(new DifftasticError("spawn_failed", `failed to spawn difftastic: ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Without --exit-code, difft exits 0 whether or not files differ.
      // 2 = usage error, 101 = panic.
      if (code !== 0) {
        reject(
          new DifftasticError(
            "exit_error",
            `difftastic exited with code ${code ?? "unknown"}: ${stderrText.trim().slice(0, 500)}`,
          ),
        );
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(
          new DifftasticError(
            "invalid_json",
            `difftastic stdout is not valid JSON (is DFT_UNSTABLE honored?): ${stdout
              .trim()
              .slice(0, 200)}`,
          ),
        );
        return;
      }

      if (Array.isArray(parsed)) {
        if (parsed.length !== 1) {
          reject(shapeError(`expected 1 file entry, got array of ${parsed.length}`));
          return;
        }
        parsed = parsed[0];
      }
      if (!isRecord(parsed)) {
        reject(shapeError("top-level value is not an object"));
        return;
      }
      resolve(parsed);
    });
  });
}

// ---------------------------------------------------------------------------
// Mapping difft JSON -> ParsedDiffFile
// ---------------------------------------------------------------------------

export interface WordChangeRange {
  start: number;
  end: number;
}

export interface DifftasticDiffLine extends DiffLine {
  // Char-column (JS string index / UTF-16 code unit) ranges. difft emits
  // UTF-8 BYTE offsets; the mapper converts them.
  changedRanges?: WordChangeRange[];
}

export interface DifftasticDiffHunk extends DiffHunk {
  lines: DifftasticDiffLine[];
}

export interface DifftasticParsedDiffFile extends ParsedDiffFile {
  hunks: DifftasticDiffHunk[];
}

interface DifftChangeToken {
  start: number;
  end: number;
}

interface RowMarks {
  lhs: DifftChangeToken[] | null;
  rhs: DifftChangeToken[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw shapeError(`"${field}" is not a string`);
  }
  return value;
}

function expectLineIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw shapeError(`"${field}" is not a non-negative integer`);
  }
  return value;
}

// Split blob text into lines the way difft indexes them (0-based). difft runs
// with --strip-cr on, so its byte offsets are computed on CR-stripped lines —
// strip here too to keep columns consistent.
function splitBlobLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

// difft change offsets are UTF-8 byte offsets into the line; JS consumers
// (changedRanges) want UTF-16 code unit indices. Build a byte->char converter
// for one line.
function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function createByteToCharConverter(lineText: string): (byteOffset: number) => number {
  const boundaries = new Map<number, number>();
  let byte = 0;
  let unit = 0;
  boundaries.set(0, 0);
  for (const codePointStr of lineText) {
    byte += utf8ByteLength(codePointStr.codePointAt(0) as number);
    unit += codePointStr.length;
    boundaries.set(byte, unit);
  }
  const totalBytes = byte;
  return (byteOffset: number): number => {
    if (byteOffset >= totalBytes) return lineText.length;
    const exact = boundaries.get(byteOffset);
    if (exact !== undefined) return exact;
    // Offset inside a multi-byte code point (schema drift) — clamp to the
    // nearest preceding boundary.
    let best = 0;
    for (const [b, u] of boundaries) {
      if (b <= byteOffset && u > best) best = u;
    }
    return best;
  };
}

function convertChangesToRanges(changes: DifftChangeToken[], lineText: string): WordChangeRange[] {
  const toChar = createByteToCharConverter(lineText);
  const ranges: WordChangeRange[] = [];
  for (const change of changes) {
    const start = toChar(change.start);
    const end = toChar(change.end);
    if (end > start) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

// Whole-line suppression, mirroring the app's computeWordChangeRanges: when a
// line is entirely changed the solid line tint reads better than a second
// full-width intra-line layer. difft marks every token of brand-new lines, so
// without this every added line would be double-painted. "Whole line" = every
// non-whitespace char is covered by some range.
function coversWholeLine(lineText: string, ranges: WordChangeRange[]): boolean {
  if (ranges.length === 0) return false;
  for (let i = 0; i < lineText.length; i++) {
    if (/\s/.test(lineText[i])) continue;
    if (!ranges.some((range) => i >= range.start && i < range.end)) {
      return false;
    }
  }
  return true;
}

function parseChangeTokens(value: unknown, field: string): DifftChangeToken[] {
  if (!Array.isArray(value)) {
    throw shapeError(`"${field}.changes" is not an array`);
  }
  return value.map((entry, i) => {
    if (!isRecord(entry)) {
      throw shapeError(`"${field}.changes[${i}]" is not an object`);
    }
    const start = expectLineIndex(entry.start, `${field}.changes[${i}].start`);
    const end = expectLineIndex(entry.end, `${field}.changes[${i}].end`);
    return { start, end };
  });
}

interface AlignedPair {
  lhs: number | null;
  rhs: number | null;
}

function parseAlignedLines(
  value: unknown,
  oldLineCount: number,
  newLineCount: number,
): AlignedPair[] {
  if (!Array.isArray(value)) {
    throw shapeError('"aligned_lines" is not an array');
  }
  const pairs: AlignedPair[] = value.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw shapeError(`"aligned_lines[${i}]" is not a pair`);
    }
    const [lhs, rhs] = entry as [unknown, unknown];
    return {
      lhs: lhs === null ? null : expectLineIndex(lhs, `aligned_lines[${i}][0]`),
      rhs: rhs === null ? null : expectLineIndex(rhs, `aligned_lines[${i}][1]`),
    };
  });

  // difft appends an EOF pair (indices == line counts, one past the end).
  // Drop trailing pairs that reference lines beyond both blobs.
  while (pairs.length > 0) {
    const last = pairs[pairs.length - 1];
    const lhsOut = last.lhs === null || last.lhs >= oldLineCount;
    const rhsOut = last.rhs === null || last.rhs >= newLineCount;
    if ((last.lhs !== null || last.rhs !== null) && lhsOut && rhsOut) {
      pairs.pop();
    } else {
      break;
    }
  }

  for (const [i, pair] of pairs.entries()) {
    if (pair.lhs !== null && pair.lhs >= oldLineCount) {
      throw shapeError(`aligned_lines[${i}] lhs ${pair.lhs} out of range`);
    }
    if (pair.rhs !== null && pair.rhs >= newLineCount) {
      throw shapeError(`aligned_lines[${i}] rhs ${pair.rhs} out of range`);
    }
    if (pair.lhs === null && pair.rhs === null) {
      throw shapeError(`aligned_lines[${i}] has both sides null`);
    }
  }

  return pairs;
}

interface HunkWindow {
  start: number;
  end: number; // inclusive pair index
}

export function mapDifftasticToParsedDiff(
  json: unknown,
  oldBlobText: string,
  newBlobText: string,
  repoRelPath: string,
): DifftasticParsedDiffFile {
  if (!isRecord(json)) {
    throw shapeError("file entry is not an object");
  }

  const status = expectString(json.status, "status");
  const language = expectString(json.language, "language");

  if (status === "created" || status === "deleted") {
    throw new DifftasticNotMappableError(
      "created_or_deleted",
      `difftastic reports status "${status}" (no chunks) — use the git path`,
    );
  }

  // difft's line-oriented fallback (byte/graph limit exceeded, parse errors)
  // reports e.g. "Text (55 B exceeded DFT_BYTE_LIMIT)". Plain "Text" (a
  // genuinely unsupported language) still maps fine.
  if (language.startsWith("Text (")) {
    throw new DifftasticNotMappableError(
      "text_fallback",
      `difftastic fell back to line-oriented mode: ${language}`,
    );
  }

  if (status === "unchanged") {
    if (oldBlobText === newBlobText) {
      return {
        path: repoRelPath,
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        status: "ok",
      };
    }
    // Structural equivalence (whitespace-only change, conflict-marker files)
    // — git must produce the diff.
    throw new DifftasticNotMappableError(
      "unchanged_mismatch",
      "difftastic reports unchanged but blob contents differ",
    );
  }

  if (status !== "changed") {
    throw shapeError(`unknown status "${status}"`);
  }

  const rawChunks = json.chunks;
  const rawAligned = json.aligned_lines;
  if (!Array.isArray(rawChunks) || rawChunks.length === 0 || rawAligned === undefined) {
    throw new DifftasticNotMappableError(
      "missing_chunks",
      "difftastic output has no chunks/aligned_lines to map",
    );
  }

  const oldLines = splitBlobLines(oldBlobText);
  const newLines = splitBlobLines(newBlobText);
  const pairs = parseAlignedLines(rawAligned, oldLines.length, newLines.length);

  const lhsPairIndex = new Map<number, number>();
  const rhsPairIndex = new Map<number, number>();
  for (const [i, pair] of pairs.entries()) {
    if (pair.lhs !== null) lhsPairIndex.set(pair.lhs, i);
    if (pair.rhs !== null) rhsPairIndex.set(pair.rhs, i);
  }

  const { rowMarks, chunkRanges } = collectRowMarks(rawChunks, lhsPairIndex, rhsPairIndex);
  const windows = buildHunkWindows(chunkRanges, pairs.length);

  const hunks: DifftasticDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;

  for (const window of windows) {
    const hunk = buildHunk(window, pairs, rowMarks, oldLines, newLines);
    additions += hunk.addCount;
    deletions += hunk.removeCount;
    hunks.push(hunk.hunk);
  }

  return {
    path: repoRelPath,
    isNew: false,
    isDeleted: false,
    additions,
    deletions,
    hunks,
    status: "ok",
  };
}

interface ChunkEntrySide {
  index: number;
  changes: DifftChangeToken[];
}

function parseChunkEntrySide(
  value: unknown,
  label: string,
  pairIndexByLine: Map<number, number>,
): ChunkEntrySide | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw shapeError(`${label} is not an object`);
  }
  const lineNumber = expectLineIndex(value.line_number, `${label}.line_number`);
  const changes = parseChangeTokens(value.changes, label);
  const index = pairIndexByLine.get(lineNumber);
  if (index === undefined) {
    throw shapeError(`${label} line ${lineNumber} missing from aligned_lines`);
  }
  return { index, changes };
}

interface CollectedRowMarks {
  rowMarks: Map<number, RowMarks>;
  // Each outer chunk group becomes one hunk candidate (merged later when
  // context windows overlap).
  chunkRanges: Array<{ min: number; max: number }>;
}

function collectRowMarks(
  rawChunks: unknown[],
  lhsPairIndex: Map<number, number>,
  rhsPairIndex: Map<number, number>,
): CollectedRowMarks {
  const rowMarks = new Map<number, RowMarks>();
  const markRow = (
    pairIndex: number,
    lhs: DifftChangeToken[] | null,
    rhs: DifftChangeToken[] | null,
  ): void => {
    const existing = rowMarks.get(pairIndex);
    if (!existing) {
      rowMarks.set(pairIndex, { lhs, rhs });
      return;
    }
    if (lhs) existing.lhs = existing.lhs ? [...existing.lhs, ...lhs] : lhs;
    if (rhs) existing.rhs = existing.rhs ? [...existing.rhs, ...rhs] : rhs;
  };

  const chunkRanges: Array<{ min: number; max: number }> = [];

  for (const [groupIndex, group] of rawChunks.entries()) {
    if (!Array.isArray(group) || group.length === 0) {
      throw shapeError(`chunks[${groupIndex}] is not a non-empty array`);
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const [entryIndex, entry] of (group as unknown[]).entries()) {
      const label = `chunks[${groupIndex}][${entryIndex}]`;
      if (!isRecord(entry)) {
        throw shapeError(`${label} is not an object`);
      }
      const lhs = parseChunkEntrySide(entry.lhs, `${label}.lhs`, lhsPairIndex);
      const rhs = parseChunkEntrySide(entry.rhs, `${label}.rhs`, rhsPairIndex);
      if (!lhs && !rhs) {
        throw shapeError(`${label} has neither lhs nor rhs`);
      }

      if (lhs && rhs && lhs.index !== rhs.index) {
        // Sides aligned to different rows — record independently.
        markRow(lhs.index, lhs.changes, null);
        markRow(rhs.index, null, rhs.changes);
      } else {
        const pairIndex = (lhs ?? rhs)!.index;
        markRow(pairIndex, lhs?.changes ?? null, rhs?.changes ?? null);
      }
      for (const side of [lhs, rhs]) {
        if (side) {
          min = Math.min(min, side.index);
          max = Math.max(max, side.index);
        }
      }
    }

    chunkRanges.push({ min, max });
  }

  return { rowMarks, chunkRanges };
}

// Expand each chunk by the context margin and merge overlapping windows so
// shared context lines are never duplicated across hunks.
function buildHunkWindows(
  chunkRanges: Array<{ min: number; max: number }>,
  pairCount: number,
): HunkWindow[] {
  const sorted = [...chunkRanges].sort((a, b) => a.min - b.min);
  const windows: HunkWindow[] = [];
  for (const range of sorted) {
    const start = Math.max(0, range.min - HUNK_CONTEXT_LINES);
    const end = Math.min(pairCount - 1, range.max + HUNK_CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

interface BuiltHunk {
  hunk: DifftasticDiffHunk;
  addCount: number;
  removeCount: number;
}

type ResolvedRow =
  | { kind: "context"; newIndex: number }
  | {
      kind: "change";
      remove?: { index: number; ranges: WordChangeRange[] | undefined };
      add?: { index: number; ranges: WordChangeRange[] | undefined };
    };

function resolveUnmarkedRow(pair: AlignedPair): ResolvedRow {
  if (pair.lhs !== null && pair.rhs !== null) {
    return { kind: "context", newIndex: pair.rhs };
  }
  // Unmarked single-sided pair — still a pure deletion/insertion.
  if (pair.lhs !== null) {
    return { kind: "change", remove: { index: pair.lhs, ranges: undefined } };
  }
  return { kind: "change", add: { index: pair.rhs as number, ranges: undefined } };
}

interface RowRanges {
  oldRanges: WordChangeRange[] | undefined;
  newRanges: WordChangeRange[] | undefined;
}

// Whole-line suppression. Paired rows follow the app rule (drop only when
// BOTH sides are fully covered); single-sided rows drop independently.
function suppressWholeLineRanges(
  { oldRanges, newRanges }: RowRanges,
  oldText: string | undefined,
  newText: string | undefined,
): RowRanges {
  const oldWhole =
    oldRanges !== undefined && oldText !== undefined && coversWholeLine(oldText, oldRanges);
  const newWhole =
    newRanges !== undefined && newText !== undefined && coversWholeLine(newText, newRanges);
  const bothSides = oldRanges !== undefined && newRanges !== undefined;
  return {
    oldRanges: oldWhole && (!bothSides || newWhole) ? undefined : oldRanges,
    newRanges: newWhole && (!bothSides || oldWhole) ? undefined : newRanges,
  };
}

function assertMarksAligned(pair: AlignedPair, marks: RowMarks, pairIndex: number): void {
  if (marks.lhs !== null && pair.lhs === null) {
    throw shapeError(`lhs changes recorded for pair ${pairIndex} with null lhs line`);
  }
  if (marks.rhs !== null && pair.rhs === null) {
    throw shapeError(`rhs changes recorded for pair ${pairIndex} with null rhs line`);
  }
}

// Paired entry with empty change lists on both sides — structural context.
function isStructuralContext(pair: AlignedPair, marks: RowMarks): boolean {
  return (
    marks.lhs?.length === 0 && marks.rhs?.length === 0 && pair.lhs !== null && pair.rhs !== null
  );
}

function resolveRow(
  pair: AlignedPair,
  marks: RowMarks | undefined,
  pairIndex: number,
  oldLines: string[],
  newLines: string[],
): ResolvedRow {
  if (!marks) {
    return resolveUnmarkedRow(pair);
  }
  assertMarksAligned(pair, marks, pairIndex);
  if (isStructuralContext(pair, marks)) {
    return { kind: "context", newIndex: pair.rhs as number };
  }
  return resolveMarkedChange(pair, marks, oldLines, newLines);
}

function resolveMarkedChange(
  pair: AlignedPair,
  marks: RowMarks,
  oldLines: string[],
  newLines: string[],
): ResolvedRow {
  const lhsMarks = marks.lhs;
  const rhsMarks = marks.rhs;

  const { oldRanges, newRanges } = suppressWholeLineRanges(
    {
      oldRanges:
        lhsMarks !== null && pair.lhs !== null
          ? convertChangesToRanges(lhsMarks, oldLines[pair.lhs])
          : undefined,
      newRanges:
        rhsMarks !== null && pair.rhs !== null
          ? convertChangesToRanges(rhsMarks, newLines[pair.rhs])
          : undefined,
    },
    pair.lhs !== null ? oldLines[pair.lhs] : undefined,
    pair.rhs !== null ? newLines[pair.rhs] : undefined,
  );

  // A marked row where the aligned pair has both sides represents a
  // modification: emit remove + add even when only one side carries marks.
  const emitRemove = lhsMarks !== null || (rhsMarks !== null && pair.lhs !== null);
  const emitAdd = rhsMarks !== null || (lhsMarks !== null && pair.rhs !== null);
  return {
    kind: "change",
    remove: emitRemove ? { index: pair.lhs as number, ranges: oldRanges } : undefined,
    add: emitAdd ? { index: pair.rhs as number, ranges: newRanges } : undefined,
  };
}

function buildHunk(
  window: HunkWindow,
  pairs: AlignedPair[],
  rowMarks: Map<number, RowMarks>,
  oldLines: string[],
  newLines: string[],
): BuiltHunk {
  const lines: DifftasticDiffLine[] = [];
  let removeBuffer: DifftasticDiffLine[] = [];
  let addBuffer: DifftasticDiffLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  let addCount = 0;
  let removeCount = 0;

  const flush = (): void => {
    lines.push(...removeBuffer, ...addBuffer);
    removeBuffer = [];
    addBuffer = [];
  };

  const pushRemove = (oldIndex: number, ranges: WordChangeRange[] | undefined): void => {
    const line: DifftasticDiffLine = { type: "remove", content: oldLines[oldIndex] };
    if (ranges && ranges.length > 0) line.changedRanges = ranges;
    removeBuffer.push(line);
    oldCount++;
    removeCount++;
  };

  const pushAdd = (newIndex: number, ranges: WordChangeRange[] | undefined): void => {
    const line: DifftasticDiffLine = { type: "add", content: newLines[newIndex] };
    if (ranges && ranges.length > 0) line.changedRanges = ranges;
    addBuffer.push(line);
    newCount++;
    addCount++;
  };

  const pushContext = (newIndex: number): void => {
    flush();
    lines.push({ type: "context", content: newLines[newIndex] });
    oldCount++;
    newCount++;
  };

  for (let i = window.start; i <= window.end; i++) {
    const pair = pairs[i];
    const marks = rowMarks.get(i);
    const row = resolveRow(pair, marks, i, oldLines, newLines);

    if (row.kind === "context") {
      pushContext(row.newIndex);
      continue;
    }
    if (row.remove) {
      pushRemove(row.remove.index, row.remove.ranges);
    }
    if (row.add) {
      pushAdd(row.add.index, row.add.ranges);
    }
  }

  flush();

  const oldStart = findStartLine(pairs, window, "lhs");
  const newStart = findStartLine(pairs, window, "rhs");

  const header: DifftasticDiffLine = {
    type: "header",
    content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  };

  return {
    hunk: {
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: [header, ...lines],
    },
    addCount,
    removeCount,
  };
}

// 1-based start line for the hunk header. When the window has no line on the
// requested side (pure insertion/deletion region), fall back to git's
// convention: the line before the change (0 when at the top of the file).
function findStartLine(pairs: AlignedPair[], window: HunkWindow, side: "lhs" | "rhs"): number {
  for (let i = window.start; i <= window.end; i++) {
    const value = pairs[i][side];
    if (value !== null) return value + 1;
  }
  for (let i = window.start - 1; i >= 0; i--) {
    const value = pairs[i][side];
    if (value !== null) return value + 1;
  }
  return 0;
}
