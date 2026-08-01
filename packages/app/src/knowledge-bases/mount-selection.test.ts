import { describe, expect, it } from "vitest";
import type { KnowledgeBase } from "@getpaseo/protocol/knowledge-base/types";
import {
  createEmptyMountPickerSelection,
  listMountSelections,
  mountSelectionsAreValid,
  setMountSlugOverride,
  toggleKnowledgeBaseSelection,
} from "./mount-selection";

function kb(partial: Pick<KnowledgeBase, "id" | "slug" | "name">): KnowledgeBase {
  return {
    id: partial.id,
    slug: partial.slug,
    name: partial.name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mount-selection", () => {
  const runbooks = kb({ id: "kb_1", slug: "company-runbooks", name: "Company runbooks" });
  const faq = kb({ id: "kb_2", slug: "product-faq", name: "FAQ" });

  it("defaults to none selected", () => {
    expect(createEmptyMountPickerSelection()).toEqual({});
  });

  it("toggles selection and defaults mount slug to KB slug", () => {
    const selected = toggleKnowledgeBaseSelection({
      selection: createEmptyMountPickerSelection(),
      knowledgeBase: runbooks,
    });
    expect(listMountSelections({ selection: selected, knowledgeBases: [runbooks, faq] })).toEqual([
      {
        knowledgeBaseId: "kb_1",
        idOrSlug: "company-runbooks",
        mountSlug: "company-runbooks",
      },
    ]);

    const cleared = toggleKnowledgeBaseSelection({
      selection: selected,
      knowledgeBase: runbooks,
    });
    expect(listMountSelections({ selection: cleared, knowledgeBases: [runbooks] })).toEqual([]);
  });

  it("allows mount slug override while checked", () => {
    const selected = toggleKnowledgeBaseSelection({
      selection: createEmptyMountPickerSelection(),
      knowledgeBase: runbooks,
    });
    const overridden = setMountSlugOverride({
      selection: selected,
      knowledgeBaseId: runbooks.id,
      mountSlug: "runbooks",
    });
    expect(listMountSelections({ selection: overridden, knowledgeBases: [runbooks] })).toEqual([
      {
        knowledgeBaseId: "kb_1",
        idOrSlug: "company-runbooks",
        mountSlug: "runbooks",
      },
    ]);
  });

  it("rejects invalid or duplicate mount slugs", () => {
    expect(
      mountSelectionsAreValid([{ knowledgeBaseId: "kb_1", idOrSlug: "a", mountSlug: "Bad Slug" }]),
    ).toBe(false);
    expect(
      mountSelectionsAreValid([
        { knowledgeBaseId: "kb_1", idOrSlug: "a", mountSlug: "runbooks" },
        { knowledgeBaseId: "kb_2", idOrSlug: "b", mountSlug: "runbooks" },
      ]),
    ).toBe(false);
    expect(
      mountSelectionsAreValid([
        { knowledgeBaseId: "kb_1", idOrSlug: "a", mountSlug: "runbooks" },
        { knowledgeBaseId: "kb_2", idOrSlug: "b", mountSlug: "faq" },
      ]),
    ).toBe(true);
  });
});
