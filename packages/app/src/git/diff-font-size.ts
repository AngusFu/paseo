import { DIFF_FONT_SIZE, type DiffFontSizeStep } from "@/styles/theme";

// Menu order, smallest to largest. Typed against the theme scale so a step added or
// renamed there fails the build here instead of silently missing from the menu.
export const DIFF_FONT_SIZE_STEPS: readonly DiffFontSizeStep[] = [
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "xxl",
  "xxxl",
];

/**
 * Resolve the effective diff font size for a step. The scale is authored at the
 * default codeFontSize (12), where `md` is that value exactly — so at defaults every
 * step resolves to its authored token verbatim. When the user's settings-level
 * codeFontSize differs, each step scales proportionally (ratio to `md`) so both
 * controls compose: `md` always equals the settings value, never overrides it.
 */
export function resolveDiffFontSize(step: DiffFontSizeStep, codeFontSize: number): number {
  return Math.round((codeFontSize * DIFF_FONT_SIZE[step]) / DIFF_FONT_SIZE.md);
}
