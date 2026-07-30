import { describe, expect, it } from "vitest";

import { normalizeCursorPrintCatalogModelId } from "./cursor-print-model";

describe("normalizeCursorPrintCatalogModelId", () => {
  it.each([
    ["composer-2.5-fast", "composer-2.5"],
    ["cursor-grok-4.5-high-fast", "cursor-grok-4.5"],
    ["gpt-5.5-extra-high", "gpt-5.5"],
    ["gpt-5.4-mini-medium", "gpt-5.4-mini"],
    ["auto", "auto"],
  ] as const)("maps %s → %s", (wireId, baseId) => {
    expect(normalizeCursorPrintCatalogModelId(wireId)).toBe(baseId);
  });
});
