import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  __resetDiffEngineSeamsForTests,
  __setDiffEngineSeamsForTests,
  buildGitDiffArgs,
  getCheckoutDiff,
} from "./checkout-git.js";
import { VscodeDiffTimeoutError } from "./vscode-diff-engine.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "difftastic");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString("utf8");
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-git-difftool-")));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitFile(cwd: string, name: string, content: string, message: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", message]);
}

describe("buildGitDiffArgs", () => {
  it("always applies spawn hygiene flags", () => {
    expect(buildGitDiffArgs({ extra: ["--name-status", "HEAD"] })).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "HEAD",
    ]);
  });

  it("adds --diff-algorithm only when explicitly requested", () => {
    expect(buildGitDiffArgs({ gitAlgorithm: "histogram", extra: [] })).toContain(
      "--diff-algorithm=histogram",
    );
    expect(buildGitDiffArgs({ extra: [] }).some((arg) => arg.startsWith("--diff-algorithm"))).toBe(
      false,
    );
  });

  it("keeps -w after the hygiene flags", () => {
    const args = buildGitDiffArgs({
      ignoreWhitespace: true,
      gitAlgorithm: "patience",
      extra: ["HEAD"],
    });
    expect(args).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-algorithm=patience",
      "-w",
      "HEAD",
    ]);
  });
});

describe("getCheckoutDiff refs mode", () => {
  let repo: string;

  beforeEach(() => {
    repo = createRepo();
    // base commit shared by both branches
    commitFile(repo, "file.txt", "base\n", "base");
    // feature branch: edit file.txt
    git(repo, ["checkout", "-b", "feature"]);
    commitFile(repo, "file.txt", "base\nfeature\n", "feature change");
    // main advances independently
    git(repo, ["checkout", "main"]);
    commitFile(repo, "other.txt", "main only\n", "main change");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("compares from the merge base by default (only changes since divergence)", async () => {
    const result = await getCheckoutDiff(repo, {
      mode: "refs",
      fromRef: "feature",
      includeStructured: true,
    });
    const paths = (result.structured ?? []).map((file) => file.path);
    // HEAD (main) added other.txt since the merge base; feature's file.txt
    // edit is on the other side of the fork and must not appear.
    expect(paths).toEqual(["other.txt"]);
  });

  it("compares refs directly when mergeBase is false", async () => {
    const result = await getCheckoutDiff(repo, {
      mode: "refs",
      fromRef: "feature",
      mergeBase: false,
      includeStructured: true,
    });
    const paths = (result.structured ?? []).map((file) => file.path).sort();
    // Direct two-point diff feature -> HEAD: file.txt loses the feature line,
    // other.txt appears.
    expect(paths).toEqual(["file.txt", "other.txt"]);
  });

  it("honors an explicit toRef", async () => {
    const result = await getCheckoutDiff(repo, {
      mode: "refs",
      fromRef: "main",
      toRef: "feature",
      mergeBase: false,
      includeStructured: true,
    });
    const byPath = new Map((result.structured ?? []).map((file) => [file.path, file]));
    expect(byPath.get("file.txt")?.additions).toBe(1);
    expect(byPath.get("other.txt")?.isDeleted).toBe(true);
  });

  it("excludes untracked files in refs mode", async () => {
    writeFileSync(join(repo, "untracked.txt"), "scratch\n");
    const result = await getCheckoutDiff(repo, {
      mode: "refs",
      fromRef: "feature",
      mergeBase: false,
      includeStructured: true,
    });
    const paths = (result.structured ?? []).map((file) => file.path);
    expect(paths).not.toContain("untracked.txt");
  });

  it("rejects an unknown ref with a friendly error", async () => {
    await expect(
      getCheckoutDiff(repo, { mode: "refs", fromRef: "no-such-branch", includeStructured: true }),
    ).rejects.toThrow('Unknown git ref for fromRef: "no-such-branch"');
    await expect(
      getCheckoutDiff(repo, {
        mode: "refs",
        fromRef: "feature",
        toRef: "no-such-target",
        includeStructured: true,
      }),
    ).rejects.toThrow('Unknown git ref for toRef: "no-such-target"');
  });

  it("rejects a refs compare without fromRef", async () => {
    await expect(getCheckoutDiff(repo, { mode: "refs", includeStructured: true })).rejects.toThrow(
      "Missing fromRef",
    );
  });
});

describe("getCheckoutDiff engine selection and fallback", () => {
  let repo: string;

  beforeEach(() => {
    repo = createRepo();
  });

  afterEach(() => {
    __resetDiffEngineSeamsForTests();
    rmSync(repo, { recursive: true, force: true });
  });

  function setupModifiedFile(oldContent: string, newContent: string, name = "code.ts"): void {
    commitFile(repo, name, oldContent, "old");
    writeFileSync(join(repo, name), newContent);
  }

  it("falls back to git for the whole diff when difft is not installed", async () => {
    setupModifiedFile("const value = 1;\n", "const value = 2;\n");
    __setDiffEngineSeamsForTests({ detectDifft: async () => null });

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "difftastic",
      includeStructured: true,
    });
    const file = result.structured?.[0];
    expect(file?.diffTool).toBe("git");
    expect(file?.hunks.length).toBeGreaterThan(0);
  });

  it("routes a not-mappable difftastic result to the git path for that file", async () => {
    setupModifiedFile("const value = 1;\n", "const value = 2;\n");
    const createdFixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "created", "difft.json"), "utf8"),
    ) as Record<string, unknown>;
    __setDiffEngineSeamsForTests({
      detectDifft: async () => ({ path: "/fake/difft", version: "0.69.0" }),
      runDifftJson: async () => createdFixture,
    });

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "difftastic",
      includeStructured: true,
    });
    const file = result.structured?.[0];
    expect(file?.diffTool).toBe("git");
    expect(file?.hunks.length).toBeGreaterThan(0);
  });

  it("uses difftastic output when the runner succeeds and caches by content", async () => {
    const fixtureDir = join(FIXTURES_DIR, "changed");
    const oldText = readFileSync(join(fixtureDir, "old.ts"), "utf8");
    const newText = readFileSync(join(fixtureDir, "new.ts"), "utf8");
    const json = JSON.parse(readFileSync(join(fixtureDir, "difft.json"), "utf8")) as Record<
      string,
      unknown
    >;
    setupModifiedFile(oldText, newText);
    let runnerCalls = 0;
    __setDiffEngineSeamsForTests({
      detectDifft: async () => ({ path: "/fake/difft", version: "0.69.0" }),
      runDifftJson: async () => {
        runnerCalls += 1;
        return json;
      },
    });

    const compare = {
      mode: "uncommitted",
      tool: "difftastic",
      includeStructured: true,
    } as const;
    const first = await getCheckoutDiff(repo, compare);
    const file = first.structured?.[0];
    expect(file?.diffTool).toBe("difftastic");
    expect(file?.path).toBe("code.ts");
    expect(file?.hunks.length).toBeGreaterThan(0);
    expect(runnerCalls).toBe(1);

    // Same blobs again: the mapper-result cache must absorb the recompute
    // (watch debounce would otherwise re-spawn difft per file per event).
    const second = await getCheckoutDiff(repo, compare);
    expect(second.structured?.[0]?.diffTool).toBe("difftastic");
    expect(runnerCalls).toBe(1);
  });

  it("routes created and deleted files to git under difftastic", async () => {
    commitFile(repo, "keep.txt", "keep\n", "seed");
    commitFile(repo, "doomed.txt", "bye\n", "add doomed");
    rmSync(join(repo, "doomed.txt"));
    writeFileSync(join(repo, "fresh.txt"), "hello\n");
    __setDiffEngineSeamsForTests({
      detectDifft: async () => ({ path: "/fake/difft", version: "0.69.0" }),
      runDifftJson: async () => {
        throw new Error("difft must not run for created/deleted files");
      },
    });

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "difftastic",
      includeStructured: true,
    });
    const byPath = new Map((result.structured ?? []).map((file) => [file.path, file]));
    expect(byPath.get("doomed.txt")?.diffTool).toBe("git");
    expect(byPath.get("fresh.txt")?.diffTool).toBe("git");
  });

  it("computes vscode diffs in-process", async () => {
    setupModifiedFile("line one\nline two\n", "line one\nline two changed\n", "notes.txt");

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "vscode",
      includeStructured: true,
    });
    const file = result.structured?.[0];
    expect(file?.diffTool).toBe("vscode");
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });

  it("handles untracked (created) files with the vscode engine", async () => {
    commitFile(repo, "seed.txt", "seed\n", "seed");
    writeFileSync(join(repo, "brand-new.txt"), "a\nb\n");

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "vscode",
      includeStructured: true,
    });
    const byPath = new Map((result.structured ?? []).map((file) => [file.path, file]));
    const created = byPath.get("brand-new.txt");
    expect(created?.diffTool).toBe("vscode");
    expect(created?.additions).toBe(2);
  });

  it("falls back to git for a file when vscode-diff times out", async () => {
    setupModifiedFile("alpha\n", "beta\n", "slow.txt");
    __setDiffEngineSeamsForTests({
      computeVscodeDiffFile: () => {
        throw new VscodeDiffTimeoutError("slow.txt");
      },
    });

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "vscode",
      includeStructured: true,
    });
    const file = result.structured?.[0];
    expect(file?.diffTool).toBe("git");
    expect(file?.hunks.length).toBeGreaterThan(0);
  });

  it("leaves structured output untouched for the git tool", async () => {
    setupModifiedFile("one\n", "two\n", "plain.txt");

    const result = await getCheckoutDiff(repo, {
      mode: "uncommitted",
      tool: "git",
      gitAlgorithm: "histogram",
      includeStructured: true,
    });
    const file = result.structured?.[0];
    expect(file?.diffTool).toBeUndefined();
    expect(file?.hunks.length).toBeGreaterThan(0);
  });
});
