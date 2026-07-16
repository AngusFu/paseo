import { describe, expect, it } from "vitest";
import { buildToolCallDebugJson } from "./debug-payload";

describe("buildToolCallDebugJson", () => {
  it("surfaces the mapped detail type so an unhelpful display name can be traced", () => {
    const json = buildToolCallDebugJson({
      toolName: "Other",
      status: "completed",
      detail: { type: "unknown", input: { toolName: "archive_agent" }, output: { success: true } },
      metadata: undefined,
      error: null,
    });

    const parsed = JSON.parse(json);
    expect(parsed.toolName).toBe("Other");
    expect(parsed.detailType).toBe("unknown");
    expect(parsed.detail.input).toEqual({ toolName: "archive_agent" });
  });

  it("keeps a missing detail explicit rather than dropping the key", () => {
    const parsed = JSON.parse(
      buildToolCallDebugJson({
        toolName: "search",
        status: "running",
        detail: undefined,
        metadata: undefined,
        error: null,
      }),
    );

    expect(parsed.detailType).toBeNull();
    expect(parsed.detail).toBeNull();
  });

  it("truncates oversized payloads instead of rendering a wall of text", () => {
    const json = buildToolCallDebugJson({
      toolName: "shell",
      status: "completed",
      detail: { type: "shell", command: "ls", output: "x".repeat(10_000) },
      metadata: undefined,
      error: null,
    });

    expect(json.length).toBeLessThan(4200);
    expect(json).toContain("truncated");
  });

  it("serializes an Error instead of collapsing it to an empty object", () => {
    const parsed = JSON.parse(
      buildToolCallDebugJson({
        toolName: "shell",
        status: "failed",
        detail: undefined,
        metadata: undefined,
        error: new Error("boom"),
      }),
    );

    expect(parsed.error).toEqual({ name: "Error", message: "boom" });
  });
});
