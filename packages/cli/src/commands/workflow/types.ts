import type {
  CreateWorkflowDefinitionInput,
  DispatchWorkflowRunInput,
  UpdateWorkflowDefinitionInput,
  WorkflowDefinition,
  WorkflowRun,
} from "@getpaseo/protocol/workflow/types";

export type { WorkflowDefinition, WorkflowRun };

interface NamespacedPayload<T> {
  requestId: string;
  value: T;
  error: string | null;
}

export type WorkflowDefinitionCreateOptions = CreateWorkflowDefinitionInput & {
  requestId?: string;
};
export type WorkflowDefinitionUpdateOptions = UpdateWorkflowDefinitionInput & {
  requestId?: string;
};
export type WorkflowRunDispatchOptions = DispatchWorkflowRunInput & {
  requestId?: string;
};

/** Structural subset of DaemonClient used by workflow CLI commands. */
export interface WorkflowDaemonClient {
  workflowDefinitionList(
    requestId?: string,
    options?: { cwd?: string },
  ): Promise<NamespacedPayload<WorkflowDefinition[]>>;
  workflowDefinitionGet(
    definitionId: string,
    requestId?: string,
  ): Promise<NamespacedPayload<WorkflowDefinition | null>>;
  workflowDefinitionCreate(
    options: WorkflowDefinitionCreateOptions,
  ): Promise<NamespacedPayload<WorkflowDefinition | null>>;
  workflowDefinitionUpdate(
    options: WorkflowDefinitionUpdateOptions,
  ): Promise<NamespacedPayload<WorkflowDefinition | null>>;
  workflowDefinitionDelete(
    definitionId: string,
    requestId?: string,
  ): Promise<NamespacedPayload<string>>;
  workflowDefinitionListBuiltins(
    requestId?: string,
  ): Promise<NamespacedPayload<WorkflowDefinition[]>>;
  workflowRunList(requestId?: string): Promise<NamespacedPayload<WorkflowRun[]>>;
  workflowRunGet(runId: string, requestId?: string): Promise<NamespacedPayload<WorkflowRun | null>>;
  workflowRunDispatch(
    options: WorkflowRunDispatchOptions,
  ): Promise<NamespacedPayload<WorkflowRun | null>>;
  workflowRunCancel(
    runId: string,
    requestId?: string,
  ): Promise<NamespacedPayload<WorkflowRun | null>>;
  getLastServerInfoMessage(): {
    features?: { workflow?: boolean } | null;
  } | null;
  close(): Promise<void>;
}
