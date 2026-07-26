/**
 * Resolve whether a kanban lane should render collapsed.
 *
 * - Explicit preference (user toggled) always wins.
 * - Otherwise empty lanes default collapsed so a row of 0-card statuses
 *   doesn't push real work off-screen; non-empty lanes default expanded.
 *
 * Keeping the empty/non-empty default as derived state (not a one-shot
 * useState initializer) also covers the remount race where a tab mounts
 * with cards=[] for a frame and would otherwise lock every lane shut.
 */
export function resolveColumnCollapsed(
  preference: boolean | undefined,
  cardCount: number,
): boolean {
  return preference ?? cardCount === 0;
}

export function readCollapsedPreferences(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") {
      out[key] = entry;
    }
  }
  return out;
}
