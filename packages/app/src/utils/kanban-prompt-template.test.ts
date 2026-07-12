import { describe, expect, it } from "vitest";
import { renderPromptTemplate } from "./kanban-prompt-template";

describe("renderPromptTemplate", () => {
  it("replaces known variables", () => {
    expect(
      renderPromptTemplate("Fix {{issueKey}}: {{title}}", { issueKey: "SCIF-1", title: "Bug" }),
    ).toBe("Fix SCIF-1: Bug");
  });

  it("replaces unknown variables with an empty string", () => {
    expect(renderPromptTemplate("{{title}} {{missing}}", { title: "Bug" })).toBe("Bug ");
  });

  it("replaces every occurrence of a repeated variable", () => {
    expect(renderPromptTemplate("{{key}}/{{key}}", { key: "SCIF-1" })).toBe("SCIF-1/SCIF-1");
  });

  it("returns an empty string for an empty template", () => {
    expect(renderPromptTemplate("", { title: "Bug" })).toBe("");
  });

  it("leaves literal newlines and non-placeholder text untouched", () => {
    expect(renderPromptTemplate("{{title}}\n{{url}}", { title: "Bug", url: "https://x" })).toBe(
      "Bug\nhttps://x",
    );
  });
});
