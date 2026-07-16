import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

export const CHANGES_PREFERENCES_STORAGE_KEY = "@paseo:changes-preferences";
export const LEGACY_WRAP_LINES_STORAGE_KEY = "diff-wrap-lines";
export const CHANGES_PREFERENCES_QUERY_KEY = ["changes-preferences"];

const changesPreferencesSchema = z.object({
  layout: z.enum(["unified", "split"]).optional(),
  viewMode: z.enum(["flat", "tree"]).optional(),
  wrapLines: z.boolean().optional(),
  hideWhitespace: z.boolean().optional(),
  // Diff engine selection (see CheckoutDiffCompareSchema in @getpaseo/protocol); persisted so
  // the choice survives an app restart, unlike the ref picker for branch compares.
  diffTool: z.enum(["git", "vscode", "difftastic"]).optional(),
  // Only meaningful when diffTool is "git" (or absent); left undefined until the user
  // explicitly picks an algorithm. While unset the field is omitted on the wire and the
  // server/git default (myers) applies.
  gitAlgorithm: z.enum(["histogram", "myers", "patience"]).optional(),
  // Diff text size step (see DIFF_FONT_SIZE in styles/theme.ts, resolved by
  // git/diff-font-size.ts). Optional so payloads persisted before this field existed
  // still parse; absent falls back to "md" — the pre-selector rendering.
  diffFontSize: z.enum(["xs", "sm", "md", "lg", "xl", "xxl", "xxxl"]).optional(),
  commitsCollapsed: z.boolean().optional(),
});

export interface ChangesPreferences {
  layout: "unified" | "split";
  viewMode: "flat" | "tree";
  wrapLines: boolean;
  hideWhitespace: boolean;
  diffTool: "git" | "vscode" | "difftastic";
  gitAlgorithm: "histogram" | "myers" | "patience" | undefined;
  diffFontSize: "xs" | "sm" | "md" | "lg" | "xl" | "xxl" | "xxxl";
  commitsCollapsed: boolean;
}

export const DEFAULT_CHANGES_PREFERENCES: ChangesPreferences = {
  layout: "unified",
  viewMode: "flat",
  wrapLines: false,
  hideWhitespace: false,
  diffTool: "git",
  gitAlgorithm: undefined,
  diffFontSize: "md",
  commitsCollapsed: true,
};

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

async function loadLegacyWrapLinesPreference(storage: KeyValueStorage): Promise<boolean | null> {
  const legacyValue = await storage.getItem(LEGACY_WRAP_LINES_STORAGE_KEY);
  if (legacyValue === "true") {
    return true;
  }
  if (legacyValue === "false") {
    return false;
  }
  return null;
}

export async function loadChangesPreferencesFromStorage(
  storage: KeyValueStorage,
): Promise<ChangesPreferences> {
  const stored = await storage.getItem(CHANGES_PREFERENCES_STORAGE_KEY);
  if (stored) {
    const parsed = changesPreferencesSchema.safeParse(JSON.parse(stored));
    if (parsed.success) {
      return { ...DEFAULT_CHANGES_PREFERENCES, ...parsed.data };
    }
  }

  const legacyWrapLines = await loadLegacyWrapLinesPreference(storage);
  const next = {
    ...DEFAULT_CHANGES_PREFERENCES,
    ...(legacyWrapLines !== null ? { wrapLines: legacyWrapLines } : {}),
  } satisfies ChangesPreferences;
  await storage.setItem(CHANGES_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export async function saveChangesPreferences(input: {
  queryClient: QueryClient;
  updates: Partial<ChangesPreferences>;
  storage: KeyValueStorage;
}): Promise<void> {
  const prev =
    input.queryClient.getQueryData<ChangesPreferences>(CHANGES_PREFERENCES_QUERY_KEY) ??
    DEFAULT_CHANGES_PREFERENCES;
  const next = { ...prev, ...input.updates };
  input.queryClient.setQueryData<ChangesPreferences>(CHANGES_PREFERENCES_QUERY_KEY, next);
  await input.storage.setItem(CHANGES_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
}
