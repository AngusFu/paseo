import { Sparkles } from "lucide-react-native";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/components/browser-pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { i18n } from "@/i18n/i18next";

function useDeepseekHarnessPanelDescriptor(_target: {
  kind: "deepseek_harness";
  paneId: string;
  browserId: string;
  dshWorkspaceId?: string;
  dshSessionId?: string;
}): PanelDescriptor {
  const label = i18n.t("workspace.tabs.deepseekHarness");
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready",
    icon: Sparkles,
    statusBucket: null,
  };
}

function DeepseekHarnessPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive } = usePaneFocus();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(
    target.kind === "deepseek_harness",
    "DeepseekHarnessPanel requires deepseek_harness target",
  );
  return (
    <BrowserPane
      browserId={target.browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd}
      isInteractive={isInteractive}
      onFocusPane={focusPane}
    />
  );
}

export const deepseekHarnessPanelRegistration: PanelRegistration<"deepseek_harness"> = {
  kind: "deepseek_harness",
  component: DeepseekHarnessPanel,
  useDescriptor: useDeepseekHarnessPanelDescriptor,
};
