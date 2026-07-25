import { describe, expect, it } from "vitest";
import { formatProseStopNudgePrompt, formatProseStopReentryWarningPrompt } from "./nudge-prompt.js";

describe("prose-stop nudge prompts", () => {
  it("includes pattern detail in the full nudge", () => {
    const body = formatProseStopNudgePrompt({
      pattern: "let me know",
      source: "regex",
    });
    expect(body).toContain("Matched pattern /let me know/");
    expect(body).toContain("Fix now:");
  });

  it("keeps the reentry warning short", () => {
    const body = formatProseStopReentryWarningPrompt({
      pattern: "(说一声)即可",
      source: "regex",
    });
    expect(body).toContain("still waiting in chat prose");
    expect(body).toContain("Matched /(说一声)即可/");
    expect(body).not.toContain("Fix now:");
    expect(body.split("\n").length).toBeLessThanOrEqual(3);
  });
});
