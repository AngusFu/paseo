import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runGitCommand } from "./run-git-command.js";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;

/** Where the new side of a diff lives, so context can be read from the same place. */
export type DiffContextSource = { kind: "worktree" } | { kind: "ref"; ref: string };

interface DiffContextCompare {
  mode: "uncommitted" | "base" | "refs";
  toRef?: string;
}

/**
 * The new side of a diff.
 *
 * Uncommitted and base diffs both run without a target ref, which makes git
 * compare against the working tree — so context for those must come off disk,
 * or an edit made since the diff was computed would show stale surroundings.
 * Only a ref-to-ref comparison reads from a revision.
 */
export function resolveDiffContextSource(compare: DiffContextCompare): DiffContextSource {
  if (compare.mode === "refs") {
    const toRef = compare.toRef?.trim();
    return toRef ? { kind: "ref", ref: toRef } : { kind: "worktree" };
  }
  return { kind: "worktree" };
}

export interface DiffContextSlice {
  /** 1-based line the slice starts at, or 0 when the file has no lines. */
  startLine: number;
  lines: string[];
  reachedStart: boolean;
  reachedEnd: boolean;
}

/**
 * Clamps a requested range to the file and reports whether it touched either
 * end, so the caller can retire an expand affordance rather than offer a no-op.
 */
export function sliceContextLines(
  fileLines: readonly string[],
  startLine: number,
  endLine: number,
): DiffContextSlice {
  if (fileLines.length === 0) {
    return { startLine: 0, lines: [], reachedStart: true, reachedEnd: true };
  }
  const start = Math.max(1, Math.min(startLine, fileLines.length));
  const end = Math.max(start, Math.min(endLine, fileLines.length));
  return {
    startLine: start,
    lines: fileLines.slice(start - 1, end),
    reachedStart: start <= 1,
    reachedEnd: end >= fileLines.length,
  };
}

/**
 * Splits file content into lines without inventing a trailing empty one.
 *
 * A file ending in a newline would otherwise report one line more than it has,
 * which turns "expand to the end" into a range that never reaches it.
 */
export function splitFileLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export interface ReadDiffContextInput {
  cwd: string;
  path: string;
  compare: DiffContextCompare;
  startLine: number;
  endLine: number;
}

export async function readDiffContextLines(
  input: ReadDiffContextInput,
): Promise<DiffContextSlice | null> {
  const content = await readNewSideContent(input.cwd, input.path, input.compare);
  if (content === null) {
    return null;
  }
  return sliceContextLines(splitFileLines(content), input.startLine, input.endLine);
}

async function readNewSideContent(
  cwd: string,
  path: string,
  compare: DiffContextCompare,
): Promise<string | null> {
  const source = resolveDiffContextSource(compare);
  if (source.kind === "ref") {
    try {
      const { stdout } = await runGitCommand(["show", `${source.ref}:${path}`], {
        cwd,
        envOverlay: READ_ONLY_GIT_ENV,
      });
      return stdout;
    } catch {
      return null;
    }
  }
  // Diff paths are repo-relative; an absolute one would escape the checkout.
  if (isAbsolute(path) || path.split("/").includes("..")) {
    return null;
  }
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch {
    return null;
  }
}
