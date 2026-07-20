/**
 * Ordering + truncation for the "Workflows" section of the workspace new-tab
 * menu. Project definitions (the ones checked into the repo you are looking at)
 * come first, then host definitions, then built-in templates. Anything past the
 * cap is reachable through the "all workflows" entry.
 */

export const WORKFLOW_MENU_MAX_ENTRIES = 8;

export interface WorkflowMenuDefinition {
  id: string;
  name: string;
  origin?: "store" | "builtin" | "project";
}

const ORIGIN_RANK: Record<string, number> = { project: 0, store: 1, builtin: 2 };

function originRank(origin: string | undefined): number {
  return ORIGIN_RANK[origin ?? "store"] ?? 1;
}

export function buildWorkflowMenuEntries<T extends WorkflowMenuDefinition>(
  definitions: readonly T[],
  maxEntries: number = WORKFLOW_MENU_MAX_ENTRIES,
): { entries: T[]; hasMore: boolean } {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const definition of definitions) {
    if (!definition.id || seen.has(definition.id)) {
      continue;
    }
    seen.add(definition.id);
    unique.push(definition);
  }
  // Stable within an origin group so the daemon's own ordering survives.
  const ordered = unique
    .map((definition, index) => ({ definition, index }))
    .sort(
      (left, right) =>
        originRank(left.definition.origin) - originRank(right.definition.origin) ||
        left.index - right.index,
    )
    .map((entry) => entry.definition);
  return {
    entries: ordered.slice(0, Math.max(0, maxEntries)),
    hasMore: ordered.length > Math.max(0, maxEntries),
  };
}
