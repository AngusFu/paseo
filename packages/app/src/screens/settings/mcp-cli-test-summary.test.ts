import { describe, expect, it } from "vitest";
import { formatMcpCliToolListSummary } from "./mcp-cli-test-summary";

describe("formatMcpCliToolListSummary", () => {
  it("extracts tool names from --list stdout", () => {
    const summary = formatMcpCliToolListSummary(
      [
        "get_screenshot                           Generate a screenshot  [req: nodeId]",
        "whoami                                   Returns the user",
      ].join("\n"),
      { emptyMessage: "none" },
    );
    expect(summary).toBe("2 tools: get_screenshot, whoami");
  });

  it("filters the legacy full-catalog hint from old daemons", () => {
    const summary = formatMcpCliToolListSummary(
      [
        "get_screenshot Generate a screenshot",
        "",
        "full catalog + rules: .claude/knowledge/cli/figma.md",
      ].join("\n"),
      { emptyMessage: "none" },
    );
    expect(summary).toBe("1 tools: get_screenshot");
  });

  it("truncates long lists", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `tool_${i} desc`);
    const summary = formatMcpCliToolListSummary(lines.join("\n"), {
      limit: 3,
      emptyMessage: "none",
    });
    expect(summary).toBe("20 tools: tool_0, tool_1, tool_2 (+17 more)");
  });
});
