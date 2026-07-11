import { describe, expect, it } from "vitest";
import { DIFF_FONT_SIZE, FONT_SIZE } from "@/styles/theme";
import { DIFF_FONT_SIZE_STEPS, resolveDiffFontSize } from "./diff-font-size";

describe("DIFF_FONT_SIZE scale", () => {
  it("keeps md equal to the authored code font size so the default step changes nothing", () => {
    expect(DIFF_FONT_SIZE.md).toBe(FONT_SIZE.code);
  });

  it("lists every step exactly once, in ascending size order", () => {
    expect(DIFF_FONT_SIZE_STEPS).toEqual(["xs", "sm", "md", "lg", "xl", "xxl", "xxxl"]);
    const sizes = DIFF_FONT_SIZE_STEPS.map((step) => DIFF_FONT_SIZE[step]);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(DIFF_FONT_SIZE_STEPS).toHaveLength(Object.keys(DIFF_FONT_SIZE).length);
  });
});

describe("resolveDiffFontSize", () => {
  it("resolves each step to its authored token at the default code font size", () => {
    const resolved = DIFF_FONT_SIZE_STEPS.map((step) => resolveDiffFontSize(step, FONT_SIZE.code));
    expect(resolved).toEqual([10, 11, 12, 13, 15, 17, 20]);
  });

  it("keeps md identical to the settings-level code font size at any value", () => {
    for (const codeFontSize of [10, 12, 14, 16, 20]) {
      expect(resolveDiffFontSize("md", codeFontSize)).toBe(codeFontSize);
    }
  });

  it("scales non-default steps proportionally and rounds to whole pixels", () => {
    // 16 × (10 / 12) = 13.33… → 13; 16 × (20 / 12) = 26.67… → 27
    expect(resolveDiffFontSize("xs", 16)).toBe(13);
    expect(resolveDiffFontSize("xxxl", 16)).toBe(27);
  });

  it("pairs with the pane's 1.5× line-height formula at the authored ratio", () => {
    // The diff pane derives line-height as round(1.5 × fontSize) from the resolved
    // size — at md/12 that is the LINE_HEIGHT.diff token value (18).
    expect(Math.round(resolveDiffFontSize("md", FONT_SIZE.code) * 1.5)).toBe(18);
  });
});
