import type { KnowledgeBaseTreeNode } from "@getpaseo/protocol/knowledge-base/types";

export interface KnowledgeBaseTreeItem {
  node: KnowledgeBaseTreeNode;
  depth: number;
  children: KnowledgeBaseTreeItem[];
}

/** Build a display hierarchy from the flat `list_tree` payload. */
export function buildKnowledgeBaseTree(
  nodes: readonly KnowledgeBaseTreeNode[],
): KnowledgeBaseTreeItem[] {
  const byParent = new Map<string | null, KnowledgeBaseTreeNode[]>();
  for (const node of nodes) {
    const key = node.parentPath;
    const list = byParent.get(key);
    if (list) {
      list.push(node);
    } else {
      byParent.set(key, [node]);
    }
  }

  function sortNodes(list: KnowledgeBaseTreeNode[]): KnowledgeBaseTreeNode[] {
    return [...list].sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  function walk(parentPath: string | null, depth: number): KnowledgeBaseTreeItem[] {
    const children = sortNodes(byParent.get(parentPath) ?? []);
    return children.map((node) => ({
      node,
      depth,
      children: walk(node.path, depth + 1),
    }));
  }

  return walk(null, 0);
}

export function flattenKnowledgeBaseTree(
  roots: readonly KnowledgeBaseTreeItem[],
): KnowledgeBaseTreeItem[] {
  const out: KnowledgeBaseTreeItem[] = [];
  function visit(items: readonly KnowledgeBaseTreeItem[]) {
    for (const item of items) {
      out.push(item);
      visit(item.children);
    }
  }
  visit(roots);
  return out;
}

/** Keep only nodes whose ancestor directories are expanded. */
export function filterVisibleKnowledgeBaseTree(
  flatTree: readonly KnowledgeBaseTreeItem[],
  nodes: readonly KnowledgeBaseTreeNode[],
  expandedDirs: ReadonlySet<string>,
): KnowledgeBaseTreeItem[] {
  return flatTree.filter((item) => {
    if (!item.node.parentPath) return true;
    let parent: string | null = item.node.parentPath;
    while (parent) {
      if (!expandedDirs.has(parent)) return false;
      const parentNode = nodes.find((node) => node.path === parent);
      parent = parentNode?.parentPath ?? null;
    }
    return true;
  });
}
