/**
 * Pinned workspace tabs.
 *
 * A pinned tab is one the user wants to keep around: it sits at the front of
 * its pane, and the bulk-close actions (close to the left/right, close others)
 * step over it. Closing it on purpose still works — pinning guards against the
 * sweeping actions, it does not make a tab permanent.
 *
 * The flag lives on the tab itself rather than in a side list, so it is carried
 * by the same persistence that already restores the tab.
 */

interface PinnableTab {
  pinned?: boolean;
}

/**
 * Moves pinned tabs to the front, keeping the relative order within each group.
 *
 * Ordering here rather than in the layout store keeps the pane's own tab order
 * as the user left it: a drag decides the order inside the pinned block and
 * inside the rest, and pinning is the only thing that separates the two.
 */
export function orderPinnedTabsFirst<T extends PinnableTab>(tabs: readonly T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const tab of tabs) {
    if (tab.pinned) {
      pinned.push(tab);
    } else {
      rest.push(tab);
    }
  }
  // Nothing pinned (the common case) — hand back a plain copy rather than
  // rebuilding the array in two halves.
  return pinned.length === 0 ? [...tabs] : [...pinned, ...rest];
}

export function excludePinnedTabs<T extends PinnableTab>(tabs: readonly T[]): T[] {
  return tabs.filter((tab) => !tab.pinned);
}

export interface ClosableTabCounts {
  before: number;
  after: number;
  others: number;
}

/**
 * How many tabs each bulk-close action would actually close, once the pinned
 * ones are taken out. The menu disables an action that would close nothing, so
 * "close others" among nothing but pinned tabs no longer opens a confirmation
 * for an empty set.
 *
 * Pinned tabs occupy the first `pinnedTabCount` positions, which is what makes
 * this countable from an index alone.
 */
export function countClosableTabs(input: {
  index: number;
  tabCount: number;
  pinnedTabCount: number;
}): ClosableTabCounts {
  const { index, tabCount } = input;
  const pinnedTabCount = Math.min(Math.max(input.pinnedTabCount, 0), tabCount);
  const isPinned = index < pinnedTabCount;
  const pinnedBefore = Math.min(index, pinnedTabCount);
  const pinnedAfter = pinnedTabCount - pinnedBefore - (isPinned ? 1 : 0);
  const before = index - pinnedBefore;
  const after = tabCount - index - 1 - pinnedAfter;
  return { before, after, others: before + after };
}
