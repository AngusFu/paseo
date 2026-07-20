import { describe, expect, it } from "vitest";
import { buildWorkflowMenuEntries, WORKFLOW_MENU_MAX_ENTRIES } from "./workflow-menu-entries";

function definition(id: string, origin?: "store" | "builtin" | "project") {
  return { id, name: id, origin };
}

describe("buildWorkflowMenuEntries", () => {
  it("puts project definitions before store ones and builtins last", () => {
    const result = buildWorkflowMenuEntries([
      definition("builtin-a", "builtin"),
      definition("store-a", "store"),
      definition("project-a", "project"),
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(["project-a", "store-a", "builtin-a"]);
    expect(result.hasMore).toBe(false);
  });

  it("keeps the incoming order inside one origin group", () => {
    const result = buildWorkflowMenuEntries([
      definition("project-b", "project"),
      definition("project-a", "project"),
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(["project-b", "project-a"]);
  });

  it("treats a missing origin as a store definition", () => {
    const result = buildWorkflowMenuEntries([
      definition("builtin-a", "builtin"),
      definition("unknown-a"),
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(["unknown-a", "builtin-a"]);
  });

  it("drops duplicate ids", () => {
    const result = buildWorkflowMenuEntries([
      definition("wf", "project"),
      definition("wf", "builtin"),
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual(["wf"]);
  });

  it("truncates past the cap and reports that more exist", () => {
    const many = Array.from({ length: WORKFLOW_MENU_MAX_ENTRIES + 3 }, (_unused, index) =>
      definition(`wf-${index}`, "store"),
    );

    const result = buildWorkflowMenuEntries(many);

    expect(result.entries).toHaveLength(WORKFLOW_MENU_MAX_ENTRIES);
    expect(result.hasMore).toBe(true);
  });

  it("reports no overflow when the list exactly fills the cap", () => {
    const exact = Array.from({ length: 3 }, (_unused, index) => definition(`wf-${index}`, "store"));

    const result = buildWorkflowMenuEntries(exact, 3);

    expect(result.entries).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });
});
