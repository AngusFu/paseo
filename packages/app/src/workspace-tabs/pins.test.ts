import { describe, expect, it } from "vitest";
import { countClosableTabs, excludePinnedTabs, orderPinnedTabsFirst } from "./pins";

function tab(tabId: string, pinned?: boolean): { tabId: string; pinned?: boolean } {
  return pinned === undefined ? { tabId } : { tabId, pinned };
}

describe("orderPinnedTabsFirst", () => {
  it("moves pinned tabs ahead of the rest", () => {
    const ordered = orderPinnedTabsFirst([tab("a"), tab("b", true), tab("c"), tab("d", true)]);

    expect(ordered.map((entry) => entry.tabId)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps the pane order inside each group", () => {
    // A drag still decides the order among the pinned tabs, and among the rest;
    // pinning only decides which group a tab is in.
    const ordered = orderPinnedTabsFirst([tab("d", true), tab("b", true), tab("c"), tab("a")]);

    expect(ordered.map((entry) => entry.tabId)).toEqual(["d", "b", "c", "a"]);
  });

  it("leaves a pane with nothing pinned alone", () => {
    const ordered = orderPinnedTabsFirst([tab("a"), tab("b", false), tab("c")]);

    expect(ordered.map((entry) => entry.tabId)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the tabs it was given", () => {
    const tabs = [tab("a"), tab("b", true)];

    orderPinnedTabsFirst(tabs);

    expect(tabs.map((entry) => entry.tabId)).toEqual(["a", "b"]);
  });

  it("handles an empty pane", () => {
    expect(orderPinnedTabsFirst([])).toEqual([]);
  });
});

describe("excludePinnedTabs", () => {
  it("drops pinned tabs from a bulk-close set", () => {
    const closable = excludePinnedTabs([tab("a"), tab("b", true), tab("c")]);

    expect(closable.map((entry) => entry.tabId)).toEqual(["a", "c"]);
  });

  it("can empty the set when everything in range is pinned", () => {
    expect(excludePinnedTabs([tab("a", true), tab("b", true)])).toEqual([]);
  });
});

describe("countClosableTabs", () => {
  it("counts every other tab when nothing is pinned", () => {
    expect(countClosableTabs({ index: 1, tabCount: 4, pinnedTabCount: 0 })).toEqual({
      before: 1,
      after: 2,
      others: 3,
    });
  });

  it("does not count the pinned block sitting to the left", () => {
    // [P P a b] with the cursor on "a": nothing closable to the left.
    expect(countClosableTabs({ index: 2, tabCount: 4, pinnedTabCount: 2 })).toEqual({
      before: 0,
      after: 1,
      others: 1,
    });
  });

  it("counts nothing to the left of a pinned tab, and skips its pinned neighbours", () => {
    // [P P a b] with the cursor on the first pinned tab.
    expect(countClosableTabs({ index: 0, tabCount: 4, pinnedTabCount: 2 })).toEqual({
      before: 0,
      after: 2,
      others: 2,
    });
  });

  it("reports nothing closable when every other tab is pinned", () => {
    expect(countClosableTabs({ index: 2, tabCount: 3, pinnedTabCount: 2 })).toEqual({
      before: 0,
      after: 0,
      others: 0,
    });
  });

  it("clamps a pinned count that outruns the pane", () => {
    expect(countClosableTabs({ index: 0, tabCount: 2, pinnedTabCount: 9 })).toEqual({
      before: 0,
      after: 0,
      others: 0,
    });
  });
});
