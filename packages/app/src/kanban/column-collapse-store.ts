import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { readCollapsedPreferences } from "./column-collapse";

interface KanbanColumnCollapseState {
  /** columnId → collapsed. Absent means "use the empty/non-empty default". */
  preferences: Record<string, boolean>;
  setCollapsed: (columnId: string, collapsed: boolean) => void;
}

interface KanbanColumnCollapsePersistedState {
  preferences: Record<string, boolean>;
}

export const useKanbanColumnCollapseStore = create<KanbanColumnCollapseState>()(
  persist(
    (set) => ({
      preferences: {},
      setCollapsed: (columnId, collapsed) =>
        set((state) => {
          if (state.preferences[columnId] === collapsed) {
            return state;
          }
          return {
            preferences: { ...state.preferences, [columnId]: collapsed },
          };
        }),
    }),
    {
      name: "kanban-column-collapse",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state): KanbanColumnCollapsePersistedState => ({
        preferences: state.preferences,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as KanbanColumnCollapsePersistedState | undefined;
        return {
          ...currentState,
          preferences: readCollapsedPreferences(persisted?.preferences),
        };
      },
    },
  ),
);
