import type { SortOption } from "@/stores/panel-store";
import type { ExplorerEntry } from "@/stores/session-store";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";

export interface FileExplorerSearchEntry {
  path: string;
  kind: "file" | "directory";
}

export interface FileExplorerSearchRow {
  entry: ExplorerEntry;
  depth: number;
  displayName: string;
}

const SEARCH_PLACEHOLDER_DATE = "1970-01-01T00:00:00.000Z";

export function explorerEntryFromSearchSuggestion(entry: FileExplorerSearchEntry): ExplorerEntry {
  const name = entry.path.split("/").toReversed().find(Boolean) ?? entry.path;
  return {
    name,
    path: entry.path,
    kind: entry.kind,
    size: 0,
    modifiedAt: SEARCH_PLACEHOLDER_DATE,
  };
}

export function filterSearchSuggestions(
  entries: readonly FileExplorerSearchEntry[],
  showHiddenFiles: boolean,
): FileExplorerSearchEntry[] {
  if (showHiddenFiles) {
    return [...entries];
  }
  return entries.filter((entry) => !isHiddenExplorerPath(entry.path));
}

function sortSearchEntries(entries: ExplorerEntry[], sortOption: SortOption): ExplorerEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    switch (sortOption) {
      case "name":
        return a.path.localeCompare(b.path);
      case "modified":
      case "size":
        return a.path.localeCompare(b.path);
      default:
        return 0;
    }
  });
  return sorted;
}

export function buildSearchRows(
  entries: readonly FileExplorerSearchEntry[],
  sortOption: SortOption,
  showHiddenFiles: boolean,
): FileExplorerSearchRow[] {
  return sortSearchEntries(
    filterSearchSuggestions(entries, showHiddenFiles).map(explorerEntryFromSearchSuggestion),
    sortOption,
  ).map((entry) => ({
    entry,
    depth: 0,
    displayName: entry.path,
  }));
}

export function expandedPathsForReveal(entryPath: string): string[] {
  if (entryPath === ".") {
    return ["."];
  }
  const segments = entryPath.split("/").filter(Boolean);
  const paths = ["."];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    paths.push(current);
  }
  return paths;
}
