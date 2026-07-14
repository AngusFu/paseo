import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface PinnedWorkspacesStoreState {
  pinnedWorkspaceKeys: string[];
  isPinned: (workspaceKey: string) => boolean;
  togglePin: (workspaceKey: string) => void;
  /**
   * Persist a new drag-reordered order. Keeps only keys that are currently
   * pinned (drops stale keys, dedupes) so the order stays in sync with the set.
   */
  setPinnedOrder: (keys: string[]) => void;
}

interface PinnedWorkspacesPersistedState {
  pinnedWorkspaceKeys?: string[];
}

function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

export function migratePinnedWorkspacesState(persistedState: unknown): {
  pinnedWorkspaceKeys: string[];
} {
  const state = persistedState as PinnedWorkspacesPersistedState | undefined;
  return { pinnedWorkspaceKeys: normalizeKeys(state?.pinnedWorkspaceKeys ?? []) };
}

export const usePinnedWorkspacesStore = create<PinnedWorkspacesStoreState>()(
  persist(
    (set, get) => ({
      pinnedWorkspaceKeys: [],
      isPinned: (workspaceKey) => {
        const key = workspaceKey.trim();
        if (!key) return false;
        return get().pinnedWorkspaceKeys.includes(key);
      },
      togglePin: (workspaceKey) => {
        const key = workspaceKey.trim();
        if (!key) return;
        set((state) => {
          const next = state.pinnedWorkspaceKeys.includes(key)
            ? state.pinnedWorkspaceKeys.filter((existing) => existing !== key)
            : [...state.pinnedWorkspaceKeys, key];
          return { pinnedWorkspaceKeys: normalizeKeys(next) };
        });
      },
      setPinnedOrder: (keys) => {
        set((state) => {
          const currentlyPinned = new Set(state.pinnedWorkspaceKeys);
          // Take the incoming order, but only for keys that are still pinned.
          const reordered = normalizeKeys(keys).filter((key) => currentlyPinned.has(key));
          // Append any pinned keys the caller omitted so nothing is silently dropped.
          const reorderedSet = new Set(reordered);
          for (const key of state.pinnedWorkspaceKeys) {
            if (!reorderedSet.has(key)) {
              reordered.push(key);
            }
          }
          return { pinnedWorkspaceKeys: reordered };
        });
      },
    }),
    {
      name: "sidebar-pinned-workspaces",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        pinnedWorkspaceKeys: state.pinnedWorkspaceKeys,
      }),
      version: 1,
      migrate: migratePinnedWorkspacesState,
    },
  ),
);
