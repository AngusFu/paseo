import { describe, expect, it } from "vitest";
import {
  buildKnowledgeBaseTree,
  filterVisibleKnowledgeBaseTree,
  flattenKnowledgeBaseTree,
} from "./knowledge-base-tree";

describe("buildKnowledgeBaseTree", () => {
  it("nests files under directories and sorts directories first", () => {
    const nodes = [
      { path: "a.md", name: "a.md", kind: "file" as const, parentPath: null },
      { path: "guides", name: "guides", kind: "directory" as const, parentPath: null },
      { path: "guides/b.md", name: "b.md", kind: "file" as const, parentPath: "guides" },
      { path: "guides/c.md", name: "c.md", kind: "file" as const, parentPath: "guides" },
    ];
    const roots = buildKnowledgeBaseTree(nodes);

    expect(roots.map((item) => item.node.path)).toEqual(["guides", "a.md"]);
    expect(roots[0]?.children.map((item) => item.node.path)).toEqual([
      "guides/b.md",
      "guides/c.md",
    ]);
    const flat = flattenKnowledgeBaseTree(roots);
    expect(flat.map((item) => item.depth)).toEqual([0, 1, 1, 0]);
    expect(
      filterVisibleKnowledgeBaseTree(flat, nodes, new Set()).map((item) => item.node.path),
    ).toEqual(["guides", "a.md"]);
    expect(
      filterVisibleKnowledgeBaseTree(flat, nodes, new Set(["guides"])).map(
        (item) => item.node.path,
      ),
    ).toEqual(["guides", "guides/b.md", "guides/c.md", "a.md"]);
  });
});
