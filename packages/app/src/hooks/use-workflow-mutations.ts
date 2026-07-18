import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateWorkflowDefinitionInput,
  DispatchWorkflowRunInput,
  UpdateWorkflowDefinitionInput,
  WorkflowRun,
} from "@getpaseo/protocol/workflow/types";
import { useTranslation } from "react-i18next";
import { workflowDefinitionsQueryBaseKey } from "@/hooks/use-workflow-definitions";
import { workflowRunQueryBaseKey } from "@/hooks/use-workflow-run";
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
  const invalidateRunDetail = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: workflowRunQueryBaseKey }),
    [queryClient],
  );
  const create = useMutation({
    mutationFn: async (input: CreateWorkflowDefinitionInput) => {
      const payload = await client().workflowDefinitionCreate(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidateDefinitions,
  });
  const update = useMutation({
    mutationFn: async (input: UpdateWorkflowDefinitionInput) => {
      const payload = await client().workflowDefinitionUpdate(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidateDefinitions,
  });
  const remove = useMutation({
    mutationFn: async (definitionId: string) => {
      const payload = await client().workflowDefinitionDelete(definitionId);
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidateDefinitions,
  });
  const dispatch = useMutation({
    mutationFn: async (input: DispatchWorkflowRunInput): Promise<WorkflowRun> => {
      const payload = await client().workflowRunDispatch(input);
      if (payload.error) throw new Error(payload.error);
      const value = payload.value as WorkflowRun | null;
      if (!value) throw new Error(t("common.errors.error"));
      return value;
    },
    onSettled: invalidateRuns,
  });
  const cancel = useMutation({
    mutationFn: async (runId: string): Promise<WorkflowRun | null> => {
      const payload = await client().workflowRunCancel(runId);
      if (payload.error) throw new Error(payload.error);
      return payload.value as WorkflowRun | null;
    },
    onSettled: () => {
      invalidateRuns();
      invalidateRunDetail();
    },
  });
  return {
    create: (input: CreateWorkflowDefinitionInput) => create.mutateAsync(input),
    update: (input: UpdateWorkflowDefinitionInput) => update.mutateAsync(input),
    remove: (definitionId: string) => remove.mutateAsync(definitionId),
    dispatch: (input: DispatchWorkflowRunInput) => dispatch.mutateAsync(input),
    cancel: (runId: string) => cancel.mutateAsync(runId),
    isCreating: create.isPending,
    isUpdating: update.isPending,
    isRemoving: remove.isPending,
    isDispatching: dispatch.isPending,
    isCancelling: cancel.isPending,
  };
}
