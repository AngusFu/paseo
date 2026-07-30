import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

type PullRequest = NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]>;

export function normalizeBranchRef(ref: string | null | undefined): string | null {
  if (!ref) {
    return null;
  }
  let normalized = ref.trim();
  if (!normalized || normalized === "HEAD") {
    return null;
  }
  normalized = normalized.replace(/^refs\/heads\//, "");
  normalized = normalized.replace(/^origin\//, "");
  return normalized;
}

export function isTerminalPullRequestState(
  status: Pick<PullRequest, "state" | "isMerged">,
): boolean {
  if (status.isMerged) {
    return true;
  }
  const normalizedState = status.state.trim().toLowerCase();
  return normalizedState === "closed" || normalizedState === "merged";
}

export function shouldHideTerminalPullRequestOnDefaultBranch(input: {
  currentBranch: string | null | undefined;
  defaultBranch: string | null | undefined;
  pullRequest: Pick<PullRequest, "state" | "isMerged"> | null | undefined;
}): boolean {
  if (!input.pullRequest || !isTerminalPullRequestState(input.pullRequest)) {
    return false;
  }
  const currentBranch = normalizeBranchRef(input.currentBranch);
  const defaultBranch = normalizeBranchRef(input.defaultBranch);
  return currentBranch !== null && defaultBranch !== null && currentBranch === defaultBranch;
}

export function projectPullRequestForCheckoutDisplay(
  snapshot: WorkspaceGitRuntimeSnapshot,
): WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"] {
  const pullRequest = snapshot.forge.pullRequest;
  if (!pullRequest || !snapshot.git.isGit) {
    return pullRequest;
  }
  if (
    shouldHideTerminalPullRequestOnDefaultBranch({
      currentBranch: snapshot.git.currentBranch,
      defaultBranch: snapshot.git.baseRef,
      pullRequest,
    })
  ) {
    return null;
  }
  return pullRequest;
}
