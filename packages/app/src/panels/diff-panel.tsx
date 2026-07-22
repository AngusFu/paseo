import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileDiff, GitCommitHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { DiffLayoutToggle, GitDiffPane, resolveDiffLayout, SharedDiffView } from "@/git/diff-pane";
import { useDiffContextExpansion } from "@/git/use-diff-context-expansion";
import { useCommitDiffFiles } from "@/git/use-diff-files";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);

function useDiffPanelPreferences() {
  const { settings } = useAppSettings();
  const { preferences, updatePreferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  const canUseSplitLayout = isWeb && !isCompact;
  const effectiveLayout = resolveDiffLayout(preferences.layout, canUseSplitLayout);
  const displayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [effectiveLayout, preferences.wrapLines, settings.codeFontSize, settings.monoFontFamily],
  );
  const toggleLayout = useCallback(() => {
    void updatePreferences({ layout: preferences.layout === "unified" ? "split" : "unified" });
  }, [preferences.layout, updatePreferences]);
  const toggleWrapLines = useCallback(() => {
    void updatePreferences({ wrapLines: !preferences.wrapLines });
  }, [preferences.wrapLines, updatePreferences]);
  const toggleHideWhitespace = useCallback(() => {
    void updatePreferences({ hideWhitespace: !preferences.hideWhitespace });
  }, [preferences.hideWhitespace, updatePreferences]);

  return {
    preferences,
    isCompact,
    canUseSplitLayout,
    displayPreferences,
    toggleLayout,
    toggleWrapLines,
    toggleHideWhitespace,
  };
}

function PanelState({
  message,
  tone = "muted",
  testID,
}: {
  message: string;
  tone?: "muted" | "error";
  testID?: string;
}) {
  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={tone === "error" ? styles.errorText : styles.mutedText}>{message}</Text>
    </View>
  );
}

// The Changes tab renders GitDiffPane, the same component the Changes sidebar
// pane uses. Upstream builds this panel from the toolbar pieces plus
// SharedDiffView, but this fork's GitDiffPane is already the whole Changes
// surface — virtualized file list, diff-mode and branch-compare menus, text
// size, review actions — so reassembling a second, thinner copy here would
// mean two Changes UIs drifting apart.
function WorkingDiffPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isActive = useRetainedPanelActive();
  invariant(target.kind === "working_diff", "WorkingDiffPanel requires working_diff target");

  if (!cwd) {
    return <View style={styles.container} testID="working-diff-panel" />;
  }

  return (
    <View style={styles.container} testID="working-diff-panel">
      <GitDiffPane serverId={serverId} workspaceId={workspaceId} cwd={cwd} enabled={isActive} />
    </View>
  );
}

function CommitDiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const panelPreferences = useDiffPanelPreferences();
  invariant(target.kind === "commit_diff", "CommitDiffPanel requires commit_diff target");
  const { files, isLoading, error, capabilityMissing } = useCommitDiffFiles({
    serverId,
    cwd: cwd ?? "",
    sha: target.sha,
    enabled: Boolean(cwd),
  });
  // Context for a commit diff is read from the commit's own tree: `toRef` is
  // the commit sha, `fromRef` its parent. A root commit has no parent, but
  // that's harmless here — the server only reads content at `toRef`.
  const contextCompare = useMemo(
    () => ({ mode: "refs" as const, fromRef: `${target.sha}^`, toRef: target.sha }),
    [target.sha],
  );
  const contextExpansion = useDiffContextExpansion({
    serverId,
    cwd: cwd ?? "",
    compare: contextCompare,
    enabled: Boolean(cwd),
  });
  const mode = useMemo(() => ({ kind: "commit" as const }), []);

  let body: ReactNode;
  if (!cwd) {
    body = <PanelState message={t("panels.diff.directoryMissing")} />;
  } else if (capabilityMissing) {
    body = (
      <PanelState
        message={t("panels.diff.capabilityMissing")}
        testID="commit-diff-capability-missing"
      />
    );
  } else if (error) {
    body = (
      <PanelState message={t("panels.diff.loadError")} tone="error" testID="commit-diff-error" />
    );
  } else if (isLoading && files.length === 0) {
    body = <PanelState message={t("workspace.tabs.loading")} testID="commit-diff-loading" />;
  } else if (files.length === 0) {
    body = <PanelState message={t("panels.diff.empty")} testID="commit-diff-empty" />;
  } else {
    body = (
      <SharedDiffView
        files={files}
        displayPreferences={panelPreferences.displayPreferences}
        contextExpansion={contextExpansion}
        mode={mode}
      />
    );
  }

  return (
    <View style={styles.container} testID="commit-diff-panel">
      {panelPreferences.canUseSplitLayout ? (
        <View style={styles.toolbar}>
          <View style={styles.toolbarActions} testID="commit-diff-toolbar">
            <DiffLayoutToggle
              layout={panelPreferences.preferences.layout}
              isMobile={panelPreferences.isCompact}
              testID="commit-diff-toggle-layout"
              onToggle={panelPreferences.toggleLayout}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.body}>{body}</View>
    </View>
  );
}

function useWorkingDiffPanelDescriptor(): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: t("panels.diff.changesLabel"),
    subtitle: t("panels.diff.changesSubtitle"),
    tooltip: t("panels.diff.changesSubtitle"),
    titleState: "ready",
    icon: ThemedFileDiff,
    statusBucket: null,
  };
}

function useCommitDiffPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "commit_diff" }>,
): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: target.sha.slice(0, 7),
    subtitle: t("panels.diff.commitSubtitle"),
    tooltip: target.sha,
    titleState: "ready",
    icon: ThemedGitCommitHorizontal,
    statusBucket: null,
  };
}

export const workingDiffPanelRegistration: PanelRegistration<"working_diff"> = {
  kind: "working_diff",
  component: WorkingDiffPanel,
  useDescriptor: useWorkingDiffPanelDescriptor,
};

export const commitDiffPanelRegistration: PanelRegistration<"commit_diff"> = {
  kind: "commit_diff",
  component: CommitDiffPanel,
  useDescriptor: useCommitDiffPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    flexShrink: 0,
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[16],
  },
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
}));
