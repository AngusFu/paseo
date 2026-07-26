import { describe, expect, it } from "vitest";
import { readCollapsedPreferences, resolveColumnCollapsed } from "./column-collapse";

describe("resolveColumnCollapsed", () => {
  it("defaults empty lanes collapsed and non-empty lanes expanded", () => {
    expect(resolveColumnCollapsed(undefined, 0)).toBe(true);
    expect(resolveColumnCollapsed(undefined, 4)).toBe(false);
  });

  it("lets an explicit preference override the card-count default", () => {
    expect(resolveColumnCollapsed(true, 4)).toBe(true);
    expect(resolveColumnCollapsed(false, 0)).toBe(false);
  });
});

describe("readCollapsedPreferences", () => {
  it("keeps only boolean entries from a persisted object", () => {
    expect(
      readCollapsedPreferences({
        draft: true,
        open: false,
        junk: "nope",
        also: 1,
      }),
    ).toEqual({ draft: true, open: false });
  });

  it("returns an empty object for invalid persisted shapes", () => {
    expect(readCollapsedPreferences(undefined)).toEqual({});
    expect(readCollapsedPreferences(null)).toEqual({});
    expect(readCollapsedPreferences([])).toEqual({});
    expect(readCollapsedPreferences("draft")).toEqual({});
  });
});
