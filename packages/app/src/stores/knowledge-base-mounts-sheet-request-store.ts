import { create } from "zustand";

export interface KnowledgeBaseMountsSheetRequest {
  id: number;
  serverId: string;
  workspaceId: string;
  knowledgeBaseId?: string;
}

export interface RequestOpenKnowledgeBaseMountsSheetInput {
  serverId: string;
  workspaceId: string;
  knowledgeBaseId?: string;
}

interface KnowledgeBaseMountsSheetRequestStoreState {
  request: KnowledgeBaseMountsSheetRequest | null;
  requestOpen: (input: RequestOpenKnowledgeBaseMountsSheetInput) => void;
  clearRequest: () => void;
}

let nextRequestId = 1;

export const useKnowledgeBaseMountsSheetRequestStore =
  create<KnowledgeBaseMountsSheetRequestStoreState>((set) => ({
    request: null,
    requestOpen: (input) => {
      const serverId = input.serverId.trim();
      const workspaceId = input.workspaceId.trim();
      if (!serverId || !workspaceId) {
        return;
      }
      const knowledgeBaseId = input.knowledgeBaseId?.trim();
      set({
        request: {
          id: nextRequestId++,
          serverId,
          workspaceId,
          ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
        },
      });
    },
    clearRequest: () => set({ request: null }),
  }));

export function requestOpenKnowledgeBaseMountsSheet(
  input: RequestOpenKnowledgeBaseMountsSheetInput,
): void {
  useKnowledgeBaseMountsSheetRequestStore.getState().requestOpen(input);
}

export function clearKnowledgeBaseMountsSheetRequest(): void {
  useKnowledgeBaseMountsSheetRequestStore.getState().clearRequest();
}
