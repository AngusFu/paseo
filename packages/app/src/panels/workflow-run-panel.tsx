/**
 * Workspace tab panel for a workflow run — the synthetic "main tab" that
 * fronts every agent the run spawns. Shows the shared run detail body
 * (status, task, agents, live event log); tapping an agent opens its full
 * timeline as a pinned agent tab next to this one.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { Workflow } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useWorkflowRun } from "@/hooks/use-workflow-run";
import { useWorkflowRunLogs } from "@/hooks/use-workflow-run-logs";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useToast } from "@/contexts/toast-context";
import { useWorkflowMutations } from "@/hooks/use-workflow-mutations";
import { useWorkspaceWorkflowDefinitions } from "@/hooks/use-workspace-workflow-definitions";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { WorkflowRunDetailBody } from "@/screens/workflow-run-detail";
import { summarizeWorkflowRun } from "@/screens/workflow-run-summary";
import { useAgentsForWorkflowRun } from "@/subagents/select";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { stripWorkflowWorkspaceEmojiPrefix } from "@getpaseo/protocol/workflow/workspace-title";
import { useSessionStore } from "@/stores/session-store";

const BUCKET_PRIORITY: SidebarStateBucket[] = ["needs_input", "failed", "running", "attention"];

function useWorkflowRunPanelDescriptor(
  target: { kind: "workflow_run"; runId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const rows = useAgentsForWorkflowRun({ serverId: context.serverId, runId: target.runId });
  // The run carries its own "⚙️ <workflow name>" title in args. Read that rather
  // than the containing workspace's title: a run tab can live in a workspace it
  // did not mint (dispatching from a workflow draft tab retargets in place), and
  // there the workspace title is the user's, not the run's. Query-cached, so the
  // run panel below shares this fetch.
  const { run } = useWorkflowRun(context.serverId, target.runId);
  const runTitle = typeof run?.args.workspaceTitle === "string" ? run.args.workspaceTitle : null;
  // Old daemons never wrote workspaceTitle into args — fall back to the minted
  // workspace's own title, which is correct whenever the tab lives there.
  const workspaceTitle = useSessionStore((state) => {
    const workspace = state.sessions[context.serverId]?.workspaces.get(context.workspaceId);
    return workspace?.title ?? workspace?.name ?? null;
  });
  const buckets = new Set(
    rows.map((row) => buildSubagentRowPresentationData(row).statusBucket).filter(Boolean),
  );
  const statusBucket = BUCKET_PRIORITY.find((bucket) => buckets.has(bucket)) ?? null;
  const rawTitle = runTitle ?? workspaceTitle;
  const strippedTitle = rawTitle ? stripWorkflowWorkspaceEmojiPrefix(rawTitle) : "";

  return {
    label: strippedTitle || t("workflows.runTabLabel"),
    subtitle: "",
    titleState: "ready",
    icon: Workflow,
    statusBucket,
  };
}

function WorkflowRunPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, target } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(target.kind === "workflow_run", "WorkflowRunPanel requires workflow_run target");

  const { run, live } = useWorkflowRun(serverId, target.runId);
  const logs = useWorkflowRunLogs(run ? serverId : null, target.runId, { live });
  const [showDebug, setShowDebug] = useState(false);
  const toggleDebug = useCallback(() => setShowDebug((current) => !current), []);
  const mutations = useWorkflowMutations({ serverId });
  const { definitions } = useWorkspaceWorkflowDefinitions({
    serverId,
    cwd: run?.cwd ?? null,
  });
  const definition = definitions.find((entry) => entry.id === run?.definitionId) ?? null;
  const runName =
    typeof run?.args.workspaceTitle === "string"
      ? stripWorkflowWorkspaceEmojiPrefix(run.args.workspaceTitle)
      : (definition?.name ?? null);
  const openAgent = useCallback(
    (agentId: string) => {
      navigateToAgent({ serverId, agentId, pin: true });
    },
    [serverId],
  );

  const runId = run?.id ?? null;
  const stopRun = useCallback(() => {
    if (!runId) {
      return;
    }
    void confirmDialog({
      title: t("workflows.runCancelTitle"),
      message: t("workflows.runCancelMessage"),
      confirmLabel: t("workflows.actions.cancelRun"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) return undefined;
        return mutations.cancel(runId).catch((error: unknown) => {
          toast.error(toErrorMessage(error) || t("workflows.runCancelFailed"));
        });
      })
      .catch((error: unknown) => {
        toast.error(toErrorMessage(error));
      });
  }, [mutations, runId, t, toast]);

  if (!run) {
    return (
      <View style={styles.loadingContainer} testID="workflow-run-panel-loading">
        <ThemedActivityIndicator uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      testID="workflow-run-panel"
    >
      <WorkflowRunDetailBody
        run={run}
        summary={summarizeWorkflowRun(run)}
        live={live}
        logs={logs}
        serverId={serverId}
        onOpenAgent={openAgent}
        showDebug={showDebug}
        onToggleDebug={toggleDebug}
        runName={runName}
        description={definition?.description ?? null}
        keyboardEnabled={isInteractive}
        onStop={stopRun}
      />
    </ScrollView>
  );
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export const workflowRunPanelRegistration: PanelRegistration<"workflow_run"> = {
  kind: "workflow_run",
  component: WorkflowRunPanel,
  useDescriptor: useWorkflowRunPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    padding: theme.spacing[4],
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
}));
