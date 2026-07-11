import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  DifftasticError,
  DifftasticNotMappableError,
  detectDifft,
  invalidateDifftDetection,
  isVersionAtLeast,
  mapDifftasticToParsedDiff,
  runDifftJson,
  type DifftasticDiffLine,
} from "./difftastic.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "difftastic",
);

interface Fixture {
  json: unknown;
  oldText: string;
  newText: string;
}

function loadFixture(name: string): Fixture {
  const dir = path.join(FIXTURES_DIR, name);
  const entries = readdirSync(dir);
  const oldFile = entries.find((entry) => entry.startsWith("old."));
  const newFile = entries.find((entry) => entry.startsWith("new."));
  if (!oldFile || !newFile) {
    throw new Error(`fixture ${name} is missing old/new blobs`);
  }
  return {
    json: JSON.parse(readFileSync(path.join(dir, "difft.json"), "utf8")),
    oldText: readFileSync(path.join(dir, oldFile), "utf8"),
    newText: readFileSync(path.join(dir, newFile), "utf8"),
  };
}

function mapFixture(name: string, repoRelPath = `src/${name}.ts`) {
  const fixture = loadFixture(name);
  return mapDifftasticToParsedDiff(fixture.json, fixture.oldText, fixture.newText, repoRelPath);
}

function nonHeaderLines(hunkLines: DifftasticDiffLine[]): DifftasticDiffLine[] {
  return hunkLines.filter((line) => line.type !== "header");
}

function lineTypes(hunkLines: DifftasticDiffLine[]): string[] {
  return nonHeaderLines(hunkLines).map((line) => line.type);
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "difftastic-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeFakeDifft(dir: string, body: string, name = "difft"): string {
  const scriptPath = path.join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mapDifftasticToParsedDiff", () => {
  it("maps a simple changed file with context and char-column ranges", () => {
    const file = mapFixture("changed", "src/example.ts");

    expect(file.path).toBe("src/example.ts");
    expect(file.isNew).toBe(false);
    expect(file.isDeleted).toBe(false);
    expect(file.status).toBe("ok");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(3);
    expect(hunk.lines[0]).toEqual({ type: "header", content: "@@ -1,3 +1,3 @@" });
    expect(lineTypes(hunk.lines)).toEqual(["context", "remove", "add", "context"]);

    const [, remove, add] = nonHeaderLines(hunk.lines);
    expect(remove.content).toBe("  return a + b;");
    expect(remove.changedRanges).toEqual([{ start: 11, end: 12 }]);
    expect(add.content).toBe("  return a - b;");
    expect(add.changedRanges).toEqual([{ start: 11, end: 12 }]);
  });

  it("converts UTF-8 byte offsets to JS char columns for CJK", () => {
    // Line: const s = "中文中文" + old;  — difft reports bytes 27..30 (old)
    // and 27..31 (newv). 4 CJK chars are 12 bytes but 4 UTF-16 units.
    const file = mapFixture("cjk");
    const rows = nonHeaderLines(file.hunks[0].lines);
    const remove = rows.find((line) => line.type === "remove");
    const add = rows.find((line) => line.type === "add");

    expect(remove?.content).toBe('const s = "中文中文" + old;');
    expect(remove?.changedRanges).toEqual([{ start: 19, end: 22 }]);
    expect(remove?.content.slice(19, 22)).toBe("old");
    expect(add?.changedRanges).toEqual([{ start: 19, end: 23 }]);
    expect(add?.content.slice(19, 23)).toBe("newv");
  });

  it("converts UTF-8 byte offsets for surrogate-pair emoji", () => {
    // Line: const e = "😀😀" + old; — each emoji is 4 bytes and 2 UTF-16 units.
    const file = mapFixture("emoji");
    const rows = nonHeaderLines(file.hunks[0].lines);
    const remove = rows.find((line) => line.type === "remove");
    const add = rows.find((line) => line.type === "add");

    expect(remove?.changedRanges).toEqual([{ start: 19, end: 22 }]);
    expect(remove?.content.slice(19, 22)).toBe("old");
    expect(add?.changedRanges).toEqual([{ start: 19, end: 23 }]);
    expect(add?.content.slice(19, 23)).toBe("newv");
  });

  it("returns an empty diff for unchanged files with identical blobs", () => {
    const file = mapFixture("unchanged");
    expect(file.hunks).toEqual([]);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
    expect(file.status).toBe("ok");
  });

  it("rejects unchanged status when blobs actually differ (whitespace-only change)", () => {
    const fixture = loadFixture("ws-only");
    expect((fixture.json as { status: string }).status).toBe("unchanged");
    expect(fixture.oldText).not.toBe(fixture.newText);
    try {
      mapDifftasticToParsedDiff(fixture.json, fixture.oldText, fixture.newText, "src/x.ts");
      expect.unreachable("expected DifftasticNotMappableError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticNotMappableError);
      expect((error as DifftasticNotMappableError).reason).toBe("unchanged_mismatch");
    }
  });

  it("rejects conflict-marker files via the Text(parse errors) fallback sniff", () => {
    // difft 0.68.0 parses a conflict-marker TS file with errors and falls back
    // to its line-oriented mode — the language string is the only signal.
    const fixture = loadFixture("conflict");
    try {
      mapDifftasticToParsedDiff(fixture.json, fixture.oldText, fixture.newText, "src/x.ts");
      expect.unreachable("expected DifftasticNotMappableError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticNotMappableError);
      expect((error as DifftasticNotMappableError).reason).toBe("text_fallback");
    }
  });

  it.each(["created", "deleted"] as const)("rejects %s files", (name) => {
    try {
      mapFixture(name);
      expect.unreachable("expected DifftasticNotMappableError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticNotMappableError);
      expect((error as DifftasticNotMappableError).reason).toBe("created_or_deleted");
    }
  });

  it('rejects difft\'s own line-oriented fallback ("Text (…)" language)', () => {
    const fixture = loadFixture("text-fallback");
    expect((fixture.json as { language: string }).language).toMatch(/^Text \(/);
    try {
      mapDifftasticToParsedDiff(fixture.json, fixture.oldText, fixture.newText, "src/x.ts");
      expect.unreachable("expected DifftasticNotMappableError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticNotMappableError);
      expect((error as DifftasticNotMappableError).reason).toBe("text_fallback");
    }
  });

  it('still maps plain "Text" language (unsupported language, no fallback marker)', () => {
    const file = mapFixture("text-plain", "notes.txt");
    expect(file.hunks).toHaveLength(1);
    const rows = nonHeaderLines(file.hunks[0].lines);
    expect(rows.map((line) => line.type)).toEqual(["remove", "add"]);
    // Full-line replacement: whole-line suppression drops the ranges (matches
    // the app's computeWordChangeRanges behavior).
    expect(rows[0].changedRanges).toBeUndefined();
    expect(rows[1].changedRanges).toBeUndefined();
  });

  it("keeps far-apart chunks as separate hunks with 3 context lines each", () => {
    // Changes on line indices 1 and 13 of a 15-line file.
    const file = mapFixture("multi-chunk");
    expect(file.hunks).toHaveLength(2);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(2);

    const [first, second] = file.hunks;
    expect(first.lines[0].content).toBe("@@ -1,5 +1,5 @@");
    expect(lineTypes(first.lines)).toEqual([
      "context",
      "remove",
      "add",
      "context",
      "context",
      "context",
    ]);
    expect(nonHeaderLines(first.lines)[1].content).toBe("const b = 2;");
    expect(nonHeaderLines(first.lines)[1].changedRanges).toEqual([{ start: 10, end: 11 }]);
    expect(nonHeaderLines(first.lines)[2].content).toBe("const b = 222;");
    expect(nonHeaderLines(first.lines)[2].changedRanges).toEqual([{ start: 10, end: 13 }]);

    expect(second.lines[0].content).toBe("@@ -11,5 +11,5 @@");
    expect(second.oldStart).toBe(11);
    expect(second.newStart).toBe(11);
    expect(lineTypes(second.lines)).toEqual([
      "context",
      "context",
      "context",
      "remove",
      "add",
      "context",
    ]);
  });

  it("merges adjacent chunks with overlapping context into one hunk without duplicates", () => {
    // Changes on line indices 1 and 6: ±3 windows [0..4] and [3..9] overlap.
    const file = mapFixture("merge-chunks");
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.lines[0].content).toBe("@@ -1,10 +1,10 @@");
    expect(lineTypes(hunk.lines)).toEqual([
      "context",
      "remove",
      "add",
      "context",
      "context",
      "context",
      "context",
      "remove",
      "add",
      "context",
      "context",
      "context",
    ]);

    // No duplicated context: each context content appears exactly once.
    const contextContents = nonHeaderLines(hunk.lines)
      .filter((line) => line.type === "context")
      .map((line) => line.content);
    expect(new Set(contextContents).size).toBe(contextContents.length);
  });

  it("maps single-sided chunks (code move) via global aligned_lines", () => {
    // A function moved from the top to the bottom of the file: difft emits an
    // lhs-only chunk (deletion) and an rhs-only chunk (insertion).
    const file = mapFixture("move");
    expect(file.hunks).toHaveLength(2);
    expect(file.deletions).toBe(3);
    expect(file.additions).toBe(3);

    const [removalHunk, insertionHunk] = file.hunks;
    expect(lineTypes(removalHunk.lines)).toEqual([
      "remove",
      "remove",
      "remove",
      "context",
      "context",
      "context",
    ]);
    expect(removalHunk.oldStart).toBe(1);
    expect(removalHunk.oldCount).toBe(6);
    expect(removalHunk.newStart).toBe(1);
    expect(removalHunk.newCount).toBe(3);

    expect(lineTypes(insertionHunk.lines)).toEqual([
      "context",
      "context",
      "context",
      "add",
      "add",
      "add",
    ]);
    // Opposite-side numbering derived from aligned_lines joins.
    expect(insertionHunk.oldStart).toBe(11);
    expect(insertionHunk.oldCount).toBe(3);
    expect(insertionHunk.newStart).toBe(8);
    expect(insertionHunk.newCount).toBe(6);

    const added = nonHeaderLines(insertionHunk.lines).filter((line) => line.type === "add");
    expect(added.map((line) => line.content)).toEqual([
      "function movedFn(x: number) {",
      "  return x * 2;",
      "}",
    ]);
    // Moved lines are entirely "changed" — whole-line suppression applies.
    for (const line of added) {
      expect(line.changedRanges).toBeUndefined();
    }
  });

  it("maps a pure added block (rhs-only entries) with whole-line suppression", () => {
    const file = mapFixture("insert-block");
    expect(file.hunks).toHaveLength(1);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);

    const hunk = file.hunks[0];
    expect(hunk.lines[0].content).toBe("@@ -1,3 +1,5 @@");
    expect(lineTypes(hunk.lines)).toEqual(["context", "add", "add", "context", "context"]);
    const adds = nonHeaderLines(hunk.lines).filter((line) => line.type === "add");
    expect(adds.map((line) => line.content)).toEqual(["const NEW = 9;", "const NEW2 = 8;"]);
    for (const line of adds) {
      expect(line.changedRanges).toBeUndefined();
    }
  });

  it("maps a big file without blowing up", () => {
    const file = mapFixture("big");
    expect(file.hunks.length).toBeGreaterThan(0);
    expect(file.additions + file.deletions).toBeGreaterThan(0);
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        expect(typeof line.content).toBe("string");
      }
    }
  });

  it("reconstructs context content from the blobs, not from difft output", () => {
    const fixture = loadFixture("multi-chunk");
    const file = mapDifftasticToParsedDiff(fixture.json, fixture.oldText, fixture.newText, "x.ts");
    const firstContext = nonHeaderLines(file.hunks[0].lines)[0];
    expect(firstContext.type).toBe("context");
    expect(firstContext.content).toBe("const a = 1;");
  });

  it("throws a typed shape error on non-object input", () => {
    for (const value of [null, 42, "hi", [1, 2]]) {
      try {
        mapDifftasticToParsedDiff(value, "", "", "x.ts");
        expect.unreachable("expected DifftasticError");
      } catch (error) {
        expect(error).toBeInstanceOf(DifftasticError);
        expect((error as DifftasticError).code).toBe("invalid_shape");
      }
    }
  });

  it("treats changed status without chunks as not mappable", () => {
    try {
      mapDifftasticToParsedDiff(
        { status: "changed", language: "TypeScript", path: "x.ts" },
        "a\n",
        "b\n",
        "x.ts",
      );
      expect.unreachable("expected DifftasticNotMappableError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticNotMappableError);
      expect((error as DifftasticNotMappableError).reason).toBe("missing_chunks");
    }
  });

  it("throws a shape error on malformed aligned_lines", () => {
    const fixture = loadFixture("changed");
    const broken = { ...(fixture.json as Record<string, unknown>), aligned_lines: [[0]] };
    expect(() =>
      mapDifftasticToParsedDiff(broken, fixture.oldText, fixture.newText, "x.ts"),
    ).toThrowError(DifftasticError);
  });

  it("throws a shape error on unknown status", () => {
    expect(() =>
      mapDifftasticToParsedDiff(
        { status: "renamed", language: "TypeScript", path: "x.ts" },
        "",
        "",
        "x.ts",
      ),
    ).toThrowError(DifftasticError);
  });
});

describe("isVersionAtLeast", () => {
  it.each([
    ["0.51.0", "0.51.0", true],
    ["0.68.0", "0.51.0", true],
    ["1.0", "0.51.0", true],
    ["0.51.1", "0.51.0", true],
    ["0.50.9", "0.51.0", false],
    ["0.9.9", "0.51.0", false],
  ])("%s >= %s -> %s", (version, minimum, expected) => {
    expect(isVersionAtLeast(version, minimum)).toBe(expected);
  });
});

describe("detectDifft", () => {
  it("resolves PASEO_DIFFT_PATH first", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, 'echo "Difftastic 0.68.0"');
    const result = await detectDifft({ env: { PASEO_DIFFT_PATH: fake, PATH: "" } });
    expect(result).toEqual({ path: fake, version: "0.68.0" });
  });

  it("falls back to PATH lookup", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, 'echo "Difftastic 0.60.1"');
    const result = await detectDifft({
      env: { PATH: dir, PASEO_HOME: path.join(dir, "home") },
    });
    expect(result).toEqual({ path: fake, version: "0.60.1" });
  });

  it("falls back to $PASEO_HOME/bin/difft", async () => {
    const dir = makeTempDir();
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, "bin"), { recursive: true });
    const fake = writeFakeDifft(path.join(home, "bin"), 'echo "Difftastic 0.69.0"');
    const result = await detectDifft({ env: { PATH: "", PASEO_HOME: home } });
    expect(result).toEqual({ path: fake, version: "0.69.0" });
  });

  it("treats versions older than the JSON display minimum as not installed", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, 'echo "Difftastic 0.50.2"');
    const result = await detectDifft({
      env: { PASEO_DIFFT_PATH: fake, PATH: "", PASEO_HOME: path.join(dir, "home") },
    });
    expect(result).toBeNull();
  });

  it("skips broken binaries and unparseable version output", async () => {
    const dir = makeTempDir();
    const garbage = writeFakeDifft(dir, 'echo "not a version"');
    const result = await detectDifft({
      env: { PASEO_DIFFT_PATH: garbage, PATH: "", PASEO_HOME: path.join(dir, "home") },
    });
    expect(result).toBeNull();
  });

  it("prefers an explicit path over PATH even when both exist", async () => {
    const explicitDir = makeTempDir();
    const pathDir = makeTempDir();
    const explicit = writeFakeDifft(explicitDir, 'echo "Difftastic 0.68.0"');
    writeFakeDifft(pathDir, 'echo "Difftastic 0.69.0"');
    const result = await detectDifft({
      env: { PASEO_DIFFT_PATH: explicit, PATH: pathDir },
    });
    expect(result?.path).toBe(explicit);
  });

  it("caches the default-env detection until invalidated", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const fakeA = writeFakeDifft(dirA, 'echo "Difftastic 0.61.0"');
    const fakeB = writeFakeDifft(dirB, 'echo "Difftastic 0.62.0"');

    const previous = process.env.PASEO_DIFFT_PATH;
    try {
      invalidateDifftDetection();
      process.env.PASEO_DIFFT_PATH = fakeA;
      await expect(detectDifft()).resolves.toEqual({ path: fakeA, version: "0.61.0" });

      process.env.PASEO_DIFFT_PATH = fakeB;
      // Still cached.
      await expect(detectDifft()).resolves.toEqual({ path: fakeA, version: "0.61.0" });

      invalidateDifftDetection();
      await expect(detectDifft()).resolves.toEqual({ path: fakeB, version: "0.62.0" });
    } finally {
      if (previous === undefined) {
        delete process.env.PASEO_DIFFT_PATH;
      } else {
        process.env.PASEO_DIFFT_PATH = previous;
      }
      invalidateDifftDetection();
    }
  });
});

describe("runDifftJson", () => {
  const okJson = '{"path":"x.ts","language":"TypeScript","status":"unchanged"}';

  it("returns the parsed bare object and injects DFT_UNSTABLE", async () => {
    const dir = makeTempDir();
    // Fail unless the executor injected DFT_UNSTABLE=yes.
    const fake = writeFakeDifft(dir, `[ "$DFT_UNSTABLE" = "yes" ] || exit 2\necho '${okJson}'`);
    await expect(runDifftJson("a.ts", "b.ts", { difftPath: fake })).resolves.toEqual({
      path: "x.ts",
      language: "TypeScript",
      status: "unchanged",
    });
  });

  it("unwraps a single-element array output", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, `echo '[${okJson}]'`);
    await expect(runDifftJson("a.ts", "b.ts", { difftPath: fake })).resolves.toMatchObject({
      status: "unchanged",
    });
  });

  it("rejects non-JSON stdout (missing DFT_UNSTABLE hint text)", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(
      dir,
      'echo "JSON output is an unstable feature. Set DFT_UNSTABLE=yes."',
    );
    try {
      await runDifftJson("a.ts", "b.ts", { difftPath: fake });
      expect.unreachable("expected DifftasticError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticError);
      expect((error as DifftasticError).code).toBe("invalid_json");
    }
  });

  it("rejects non-zero exit codes with stderr detail", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, 'echo "boom" >&2\nexit 2');
    try {
      await runDifftJson("a.ts", "b.ts", { difftPath: fake });
      expect.unreachable("expected DifftasticError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticError);
      expect((error as DifftasticError).code).toBe("exit_error");
      expect((error as DifftasticError).message).toContain("boom");
    }
  });

  it("rejects when spawn fails", async () => {
    try {
      await runDifftJson("a.ts", "b.ts", {
        difftPath: path.join(makeTempDir(), "does-not-exist"),
      });
      expect.unreachable("expected DifftasticError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticError);
      expect((error as DifftasticError).code).toBe("spawn_failed");
    }
  });

  it("kills the process on timeout", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, `sleep 5\necho '${okJson}'`);
    const startedAt = Date.now();
    try {
      await runDifftJson("a.ts", "b.ts", { difftPath: fake, timeoutMs: 200 });
      expect.unreachable("expected DifftasticError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticError);
      expect((error as DifftasticError).code).toBe("timeout");
    }
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("rejects when stdout exceeds the byte cap", async () => {
    const dir = makeTempDir();
    const fake = writeFakeDifft(dir, 'head -c 100000 /dev/zero | tr "\\0" "x"');
    try {
      await runDifftJson("a.ts", "b.ts", { difftPath: fake, maxStdoutBytes: 1_000 });
      expect.unreachable("expected DifftasticError");
    } catch (error) {
      expect(error).toBeInstanceOf(DifftasticError);
      expect((error as DifftasticError).code).toBe("stdout_limit");
    }
  });

  it("limits concurrency to 2 via the semaphore", async () => {
    const dir = makeTempDir();
    // Each run takes ~300ms; 4 runs with concurrency 2 need >= 2 waves.
    const fake = writeFakeDifft(dir, `sleep 0.3\necho '${okJson}'`);
    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () => runDifftJson("a.ts", "b.ts", { difftPath: fake })),
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });
});

// End-to-end against a real difft binary when one is installed locally.
const realDifft = "/opt/homebrew/bin/difft";
describe.skipIf(!existsSync(realDifft))("runDifftJson + mapper (real difft)", () => {
  it("produces the same mapped output as the frozen fixture", async () => {
    const fixture = loadFixture("changed");
    const dir = makeTempDir();
    const oldFile = path.join(dir, "old.ts");
    const newFile = path.join(dir, "new.ts");
    writeFileSync(oldFile, fixture.oldText);
    writeFileSync(newFile, fixture.newText);

    const json = await runDifftJson(oldFile, newFile, { difftPath: realDifft });
    const mapped = mapDifftasticToParsedDiff(json, fixture.oldText, fixture.newText, "x.ts");
    const expected = mapDifftasticToParsedDiff(
      fixture.json,
      fixture.oldText,
      fixture.newText,
      "x.ts",
    );
    expect(mapped).toEqual(expected);
  });
});
