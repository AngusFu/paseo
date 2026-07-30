/**
 * Mirror of server cursor-print wire→base collapsing for catalog / favorites lookup.
 * Keep suffix list in sync with packages/server/.../cursor-print-models.ts.
 */

const EFFORT_SUFFIXES = [
  "extra-high",
  "minimal",
  "medium",
  "xhigh",
  "none",
  "high",
  "low",
  "max",
] as const;

/** Collapse a Cursor print wire model id to the catalog base id. */
export function normalizeCursorPrintCatalogModelId(
  modelId: string | null | undefined,
): string | null {
  const wireId = typeof modelId === "string" ? modelId.trim() : "";
  // Display labels from Cursor system/init must not be treated as catalog ids.
  if (!wireId || /\s/.test(wireId)) {
    return null;
  }
  let id = wireId;
  if (id.endsWith("-fast")) {
    id = id.slice(0, -"-fast".length);
  }
  if (!id) {
    return null;
  }
  for (const effort of EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return id.slice(0, -suffix.length);
    }
  }
  return id;
}

export function isCursorPrintProvider(provider: string | null | undefined): boolean {
  return provider === "cursor-print";
}
