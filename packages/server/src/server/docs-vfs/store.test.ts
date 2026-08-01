import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDocsStore,
  grepDocs,
  listDocs,
  normalizeSlug,
  parseVirtualPath,
  readDoc,
  resolveDocsRoot,
  VIRTUAL_DOCS_ROOT,
  VIRTUAL_VFS_ROOT,
} from "./store.js";

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-docs-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "guides"), { recursive: true });
  writeFileSync(join(docs, "architecture.md"), "# Architecture\n\nHooks and agents.\n");
  writeFileSync(join(docs, "guides", "start.md"), "# Start\n\nRun npm run dev.\n");
  return docs;
}

describe("docs store", () => {
  it("normalizes virtual paths and bare slugs", () => {
    expect(normalizeSlug(`${VIRTUAL_DOCS_ROOT}/architecture.md`)).toBe("architecture.md");
    expect(normalizeSlug("/paseo-vfs/runbooks/architecture.md")).toBe("architecture.md");
    expect(normalizeSlug("/architecture.md")).toBe("architecture.md");
    expect(normalizeSlug("guides/start.md")).toBe("guides/start.md");
    expect(parseVirtualPath(`${VIRTUAL_VFS_ROOT}/runbooks/a.md`)).toEqual({
      mountSlug: "runbooks",
      docSlug: "a.md",
    });
    expect(parseVirtualPath(VIRTUAL_VFS_ROOT)).toEqual({ mountSlug: null, docSlug: "" });
  });

  it("resolves docs/ by walking parents", () => {
    const docs = makeFixture();
    const nested = join(docs, "guides");
    expect(resolveDocsRoot({ cwd: nested })).toBe(docs);
  });

  it("lists root and nested directories", () => {
    const store = buildDocsStore(makeFixture());
    expect(listDocs(store)).toEqual(expect.arrayContaining(["architecture.md", "guides/"]));
    expect(listDocs(store, "guides")).toEqual(["start.md"]);
  });

  it("reads by stem and greps lexically", () => {
    const store = buildDocsStore(makeFixture());
    const doc = readDoc(store, "architecture");
    expect(doc.slug).toBe("architecture.md");
    expect(doc.content).toContain("Hooks and agents");

    const hits = grepDocs(store, "hooks", { ignoreCase: true });
    expect(hits.some((hit) => hit.slug === "architecture.md")).toBe(true);
  });
});
