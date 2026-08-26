import { agentPanelRegistration } from "@/panels/agent-panel";
import { browserPanelRegistration } from "@/panels/browser-panel";
import { deepseekHarnessPanelRegistration } from "@/panels/deepseek-harness-panel";
import { commitDiffPanelRegistration, workingDiffPanelRegistration } from "@/panels/diff-panel";
import { draftPanelRegistration } from "@/panels/draft-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { registerPanel } from "@/panels/panel-registry";
import { setupPanelRegistration } from "@/panels/setup-panel";
import { terminalPanelRegistration } from "@/panels/terminal-panel";
import { providerSubagentPanelRegistration } from "@/panels/provider-subagent-panel";
import { workflowDraftPanelRegistration } from "@/panels/workflow-draft-panel";
import { workflowRunPanelRegistration } from "@/panels/workflow-run-panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(draftPanelRegistration);
  registerPanel(agentPanelRegistration);
  registerPanel(providerSubagentPanelRegistration);
  registerPanel(workflowDraftPanelRegistration);
  registerPanel(workflowRunPanelRegistration);
  registerPanel(setupPanelRegistration);
  registerPanel(terminalPanelRegistration);
  registerPanel(browserPanelRegistration);
  registerPanel(deepseekHarnessPanelRegistration);
  registerPanel(filePanelRegistration);
  registerPanel(commitDiffPanelRegistration);
  registerPanel(workingDiffPanelRegistration);
  panelsRegistered = true;
}
