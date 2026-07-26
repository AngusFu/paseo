import { describe, expect, test } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol";
import {
  estimateCheckoutDiffOutboundBytes,
  prepareCheckoutDiffSnapshotForWire,
} from "./checkout-diff-wire-limit.js";

function makeFile(path: string, lineCount: number): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: lineCount,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: lineCount,
        lines: Array.from({ length: lineCount }, (_, index) => ({
          type: "add" as const,
          content: `line-${index}-${"x".repeat(120)}`,
          oldLineNumber: null,
          newLineNumber: index + 1,
        })),
      },
    ],
  };
}

describe("prepareCheckoutDiffSnapshotForWire", () => {
  test("always defers hunks, even for a small diff", () => {
    const snapshot = {
      cwd: "/repo",
      files: [makeFile("a.txt", 2)],
      error: null,
    };

    const prepared = prepareCheckoutDiffSnapshotForWire(snapshot);

    expect(prepared.lazyHunks).toBe(true);
    expect(prepared.wireTruncated).toBeUndefined();
    expect(prepared.totalFileCount).toBe(1);
    expect(prepared.filesOmitted).toBe(0);
    expect(prepared.files).toEqual([
      {
        path: "a.txt",
        isNew: false,
        isDeleted: false,
        additions: 2,
        deletions: 0,
        hunks: [],
        hunksDeferred: true,
      },
    ]);
  });

  test("preserves too_large placeholders without hunksDeferred", () => {
    const snapshot = {
      cwd: "/repo",
      files: [
        {
          path: "big.bin",
          isNew: false,
          isDeleted: false,
          additions: 0,
          deletions: 0,
          hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }],
          status: "too_large" as const,
        },
      ],
      error: null,
    };

    const prepared = prepareCheckoutDiffSnapshotForWire(snapshot);

    expect(prepared.lazyHunks).toBe(true);
    expect(prepared.files[0]?.status).toBe("too_large");
    expect(prepared.files[0]?.hunks).toEqual([]);
    expect(prepared.files[0]?.hunksDeferred).toBeUndefined();
  });

  test("drops trailing files only when summaries still exceed the limit", () => {
    const files = Array.from({ length: 80 }, (_, index) => makeFile(`file-${index}.txt`, 300));
    const snapshot = { cwd: "/repo", files, error: null };
    const maxBytes = 4_000;
    const compare = { mode: "base" as const, baseRef: "origin/main" };

    const prepared = prepareCheckoutDiffSnapshotForWire(snapshot, { maxBytes, compare });

    expect(prepared.lazyHunks).toBe(true);
    expect(prepared.wireTruncated).toBe(true);
    expect(prepared.totalFileCount).toBe(80);
    expect(prepared.files.length).toBeLessThan(80);
    expect(prepared.filesOmitted).toBe(80 - prepared.files.length);
    expect(estimateCheckoutDiffOutboundBytes(prepared, { compare })).toBeLessThanOrEqual(maxBytes);
  });
});
