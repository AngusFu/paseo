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
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { WorkflowRunDetailBody } from "@/screens/workflow-run-detail";
import { summarizeWorkflowRun } from "@/screens/workflow-run-summary";
import { useAgentsForWorkflowRun } from "@/subagents/select";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

const BUCKET_PRIORITY: SidebarStateBucket[] = ["needs_input", "failed", "running", "attention"];

function useWorkflowRunPanelDescriptor(
  target: { kind: "workflow_run"; runId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const rows = useAgentsForWorkflowRun({ serverId: context.serverId, runId: target.runId });
  const buckets = new Set(
    rows.map((row) => buildSubagentRowPresentationData(row).statusBucket).filter(Boolean),
  );
  const statusBucket = BUCKET_PRIORITY.find((bucket) => buckets.has(bucket)) ?? null;

  return {
    label: t("workflows.runTabLabel"),
    subtitle: "",
    titleState: "ready",
    icon: Workflow,
    statusBucket,
  };
}

function WorkflowRunPanel() {
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "workflow_run", "WorkflowRunPanel requires workflow_run target");

  const { run, live } = useWorkflowRun(serverId, target.runId);
  const logs = useWorkflowRunLogs(run ? serverId : null, target.runId, { live });
  const [showDebug, setShowDebug] = useState(false);
  const toggleDebug = useCallback(() => setShowDebug((current) => !current), []);
  const openAgent = useCallback(
    (agentId: string) => {
      navigateToAgent({ serverId, agentId, pin: true });
    },
    [serverId],
  );

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
