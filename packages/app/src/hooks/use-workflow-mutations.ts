import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateWorkflowDefinitionInput,
  DispatchWorkflowRunInput,
} from "@getpaseo/protocol/workflow/types";
import { useTranslation } from "react-i18next";
import { workflowDefinitionsQueryBaseKey } from "@/hooks/use-workflow-definitions";
import { workflowRunsQueryBaseKey } from "@/hooks/use-workflow-runs";
import { useSessionStore } from "@/stores/session-store";

export function useWorkflowMutations({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const client = useCallback(() => {
    const value = useSessionStore.getState().sessions[serverId]?.client;
    if (!value) throw new Error(t("common.errors.daemonClientUnavailable"));
    return value;
  }, [serverId, t]);
  const invalidateDefinitions = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: workflowDefinitionsQueryBaseKey }),
    [queryClient],
  );
  const invalidateRuns = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: workflowRunsQueryBaseKey }),
    [queryClient],
  );
  const create = useMutation({
    mutationFn: async (input: CreateWorkflowDefinitionInput) => {
      const payload = await client().workflowDefinitionCreate(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidateDefinitions,
  });
  const dispatch = useMutation({
    mutationFn: async (input: DispatchWorkflowRunInput) => {
      const payload = await client().workflowRunDispatch(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidateRuns,
  });
  return {
    create: (input: CreateWorkflowDefinitionInput) => create.mutateAsync(input),
    dispatch: (input: DispatchWorkflowRunInput) => dispatch.mutateAsync(input),
    isCreating: create.isPending,
    isDispatching: dispatch.isPending,
  };
}
