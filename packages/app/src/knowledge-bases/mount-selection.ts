import type { KnowledgeBase } from "@getpaseo/protocol/knowledge-base/types";
import { isValidKbMountSlug } from "./mount-slug";

/** One checked row on New Workspace / Add mount — ready for `knowledgeBaseMount`. */
export interface KnowledgeBaseMountSelection {
  knowledgeBaseId: string;
  idOrSlug: string;
  mountSlug: string;
}

/** kbId → mount slug override while checked. Absent key = not selected. */
export type MountPickerSelectionMap = Readonly<Record<string, string>>;

export function createEmptyMountPickerSelection(): MountPickerSelectionMap {
  return {};
}

export function isKnowledgeBaseSelected(
  selection: MountPickerSelectionMap,
  knowledgeBaseId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(selection, knowledgeBaseId);
}

export function toggleKnowledgeBaseSelection(input: {
  selection: MountPickerSelectionMap;
  knowledgeBase: KnowledgeBase;
}): MountPickerSelectionMap {
  const { selection, knowledgeBase } = input;
  if (Object.prototype.hasOwnProperty.call(selection, knowledgeBase.id)) {
    const next = { ...selection };
    delete next[knowledgeBase.id];
    return next;
  }
  return { ...selection, [knowledgeBase.id]: knowledgeBase.slug };
}

export function setMountSlugOverride(input: {
  selection: MountPickerSelectionMap;
  knowledgeBaseId: string;
  mountSlug: string;
}): MountPickerSelectionMap {
  if (!Object.prototype.hasOwnProperty.call(input.selection, input.knowledgeBaseId)) {
    return input.selection;
  }
  return { ...input.selection, [input.knowledgeBaseId]: input.mountSlug };
}

export function listMountSelections(input: {
  selection: MountPickerSelectionMap;
  knowledgeBases: readonly KnowledgeBase[];
}): KnowledgeBaseMountSelection[] {
  const byId = new Map(input.knowledgeBases.map((kb) => [kb.id, kb]));
  const selections: KnowledgeBaseMountSelection[] = [];
  for (const [knowledgeBaseId, mountSlugRaw] of Object.entries(input.selection)) {
    const kb = byId.get(knowledgeBaseId);
    if (!kb) continue;
    const mountSlug = mountSlugRaw.trim() || kb.slug;
    selections.push({
      knowledgeBaseId: kb.id,
      idOrSlug: kb.slug,
      mountSlug,
    });
  }
  return selections;
}

export function mountSelectionsAreValid(
  selections: readonly KnowledgeBaseMountSelection[],
): boolean {
  const seen = new Set<string>();
  for (const selection of selections) {
    if (!isValidKbMountSlug(selection.mountSlug)) {
      return false;
    }
    if (seen.has(selection.mountSlug)) {
      return false;
    }
    seen.add(selection.mountSlug);
  }
  return true;
}
