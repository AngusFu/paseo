import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORPUS_PACKAGE_FORMAT,
  isCorpusPackageDir,
  readCorpusPackage,
  writeCorpusPackage,
} from "./corpus-package.js";

describe("corpus package", () => {
  it("round-trips manifest + pages directory layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-corpus-"));
    const pages = {
      "a.md": "# A\n\nHello.\n",
      "guides/b.md": "# B\n\nWorld.\n",
    };
    const pathTree = {
      "a.md": { isPublic: true, groups: [] as string[] },
      "guides/b.md": { isPublic: true, groups: [] as string[] },
    };

    const manifest = writeCorpusPackage({
      dir,
      slug: "runbooks",
      name: "Runbooks",
      knowledgeBaseId: "kb_deadbeefdeadbeef",
      pathTree,
      pages,
      exportedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(manifest.format).toBe(CORPUS_PACKAGE_FORMAT);
    expect(manifest.pageCount).toBe(2);
    expect(isCorpusPackageDir(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).knowledgeBase.slug).toBe(
      "runbooks",
    );

    const packed = readCorpusPackage(dir);
    expect(packed.pages).toEqual(pages);
    expect(packed.manifest.pathTree).toEqual(pathTree);
  });

  it("does not treat a plain docs folder as a corpus package", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-docs-folder-"));
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.md"), "# A\n");
    expect(isCorpusPackageDir(dir)).toBe(false);
  });
});
