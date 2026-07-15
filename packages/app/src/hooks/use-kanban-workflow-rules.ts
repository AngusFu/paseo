import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateKanbanWorkflowRuleInput,
  KanbanWorkflowRule,
  UpdateKanbanWorkflowRuleInput,
} from "@getpaseo/protocol/workflow/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export const kanbanWorkflowRulesQueryBaseKey = ["kanban", "workflow-rules"] as const;
const EMPTY_RULES: KanbanWorkflowRule[] = [];

export function useKanbanWorkflowRules(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && client && connectionStatus === "online");
  const query = useFetchQuery({
    queryKey: [...kanbanWorkflowRulesQueryBaseKey, serverId ?? "none", connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) throw new Error("Workflow host client unavailable");
      const payload = await client.kanbanRuleList();
      if (payload.error) throw new Error(payload.error);
      return payload.value as KanbanWorkflowRule[];
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });
  return { rules: query.data ?? EMPTY_RULES, isLoading: enabled && query.isPending };
}

export function useKanbanWorkflowRuleMutations({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const invalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: kanbanWorkflowRulesQueryBaseKey }),
    [queryClient],
  );
  const getClient = useCallback(() => {
    const client = useSessionStore.getState().sessions[serverId]?.client;
    if (!client) throw new Error("Client unavailable");
    return client;
  }, [serverId]);
  const createMutation = useMutation({
    mutationFn: async (input: CreateKanbanWorkflowRuleInput) => {
      const payload = await getClient().kanbanRuleCreate(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: async (input: UpdateKanbanWorkflowRuleInput) => {
      const payload = await getClient().kanbanRuleUpdate(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const payload = await getClient().kanbanRuleDelete(id);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidate,
  });
  return {
    create: (input: CreateKanbanWorkflowRuleInput) => createMutation.mutateAsync(input),
    update: (input: UpdateKanbanWorkflowRuleInput) => updateMutation.mutateAsync(input),
    remove: (id: string) => deleteMutation.mutateAsync(id),
  };
}
