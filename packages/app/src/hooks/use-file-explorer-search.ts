import { useEffect, useMemo, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { buildSearchRows, type FileExplorerSearchRow } from "@/file-explorer/search";
import type { SortOption } from "@/stores/panel-store";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 100;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function useFileExplorerSearch(input: {
  client: DaemonClient | null;
  workspaceRoot: string;
  query: string;
  sortOption: SortOption;
  showHiddenFiles: boolean;
}): {
  hasQuery: boolean;
  rows: FileExplorerSearchRow[];
  isSearching: boolean;
  error: string | null;
} {
  const trimmedQuery = input.query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, SEARCH_DEBOUNCE_MS);
  const hasQuery = trimmedQuery.length > 0;

  const suggestionsQuery = useFetchQuery({
    queryKey: ["fileExplorerSearch", input.workspaceRoot, debouncedQuery, input.showHiddenFiles],
    queryFn: async () => {
      if (!input.client) {
        return { query: debouncedQuery, entries: [] as const, error: null as string | null };
      }
      const payload = await input.client.getDirectorySuggestions({
        query: debouncedQuery,
        cwd: input.workspaceRoot,
        includeFiles: true,
        includeDirectories: true,
        matchMode: "fuzzy",
        limit: SEARCH_LIMIT,
      });
      return {
        query: debouncedQuery,
        entries: payload.entries ?? [],
        error: payload.error,
      };
    },
    enabled: Boolean(input.client && debouncedQuery.length > 0),
    retry: false,
    dataShape: "list",
    staleTimeMs: 15_000,
  });

  const rows = useMemo(() => {
    if (!hasQuery) {
      return [];
    }
    if (suggestionsQuery.data?.query !== debouncedQuery) {
      return [];
    }
    return buildSearchRows(suggestionsQuery.data.entries, input.sortOption, input.showHiddenFiles);
  }, [debouncedQuery, hasQuery, input.showHiddenFiles, input.sortOption, suggestionsQuery.data]);

  const isSearching =
    hasQuery &&
    (trimmedQuery !== debouncedQuery ||
      suggestionsQuery.isFetching ||
      suggestionsQuery.data?.query !== debouncedQuery);

  const error =
    hasQuery && suggestionsQuery.data?.query === debouncedQuery
      ? (suggestionsQuery.data.error ?? null)
      : null;

  return { hasQuery, rows, isSearching, error };
}
