import type { TerminalProfile } from "@getpaseo/protocol/messages";
import type { TerminalProfileInput } from "@/screens/workspace/terminals/use-workspace-terminals";
import type { PinnedTabTarget } from "@/workspace-pins/target";

export interface TabTargetHandlers {
  createDraft: () => void;
  createTerminal: () => void;
  createBrowser: () => void;
  createTerminalWithProfile: (profile: TerminalProfileInput) => void;
  createWorkflowDraft: (definitionId: string) => void;
}

export function runPinnedTabTarget(
  target: PinnedTabTarget,
  profiles: readonly TerminalProfile[],
  handlers: TabTargetHandlers,
): void {
  if (target.kind === "draft") {
    handlers.createDraft();
    return;
  }
  if (target.kind === "terminal") {
    handlers.createTerminal();
    return;
  }
  if (target.kind === "browser") {
    handlers.createBrowser();
    return;
  }
  if (target.kind === "workflow") {
    handlers.createWorkflowDraft(target.definitionId);
    return;
  }
  const profile = profiles.find((entry) => entry.id === target.profileId);
  if (!profile) {
    return;
  }
  handlers.createTerminalWithProfile({
    name: profile.name,
    command: profile.command,
    args: profile.args,
  });
}
