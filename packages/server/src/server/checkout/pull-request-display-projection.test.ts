import { describe, expect, it } from "vitest";

import {
  normalizeBranchRef,
  projectPullRequestForCheckoutDisplay,
  shouldHideTerminalPullRequestOnDefaultBranch,
} from "./pull-request-display-projection.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

function createSnapshot(
  overrides?: Partial<WorkspaceGitRuntimeSnapshot["git"]> & {
    pullRequest?: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
  },
): WorkspaceGitRuntimeSnapshot {
  const { pullRequest, ...gitOverrides } = overrides ?? {};
  return {
    cwd: "/repo",
    git: {
      isGit: true,
      repoRoot: "/repo",
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "https://gitlab.com/group/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: true,
      diffStat: null,
      ...gitOverrides,
    },
    forge: {
      featuresEnabled: true,
      authState: "authenticated",
      forge: "gitlab",
      pullRequest: pullRequest ?? null,
      error: null,
    },
  };
}

describe("pull-request-display-projection", () => {
  it("normalizes origin/ and refs/heads/ branch prefixes", () => {
    expect(normalizeBranchRef("origin/main")).toBe("main");
    expect(normalizeBranchRef("refs/heads/dev/sciforum-frontend-v2")).toBe(
      "dev/sciforum-frontend-v2",
    );
  });

  it("hides a closed MR on the repository default branch", () => {
    expect(
      shouldHideTerminalPullRequestOnDefaultBranch({
        currentBranch: "dev/sciforum-frontend-v2",
        defaultBranch: "dev/sciforum-frontend-v2",
        pullRequest: { state: "closed", isMerged: false },
      }),
    ).toBe(true);
  });

  it("keeps an open MR on the default branch visible", () => {
    expect(
      shouldHideTerminalPullRequestOnDefaultBranch({
        currentBranch: "main",
        defaultBranch: "main",
        pullRequest: { state: "open", isMerged: false },
      }),
    ).toBe(false);
  });

  it("keeps a closed MR visible on a feature branch checkout", () => {
    expect(
      shouldHideTerminalPullRequestOnDefaultBranch({
        currentBranch: "feature/auth",
        defaultBranch: "main",
        pullRequest: { state: "closed", isMerged: false },
      }),
    ).toBe(false);
  });

  it("projects null when a terminal MR is on the default branch", () => {
    const snapshot = createSnapshot({
      currentBranch: "dev/sciforum-frontend-v2",
      baseRef: "dev/sciforum-frontend-v2",
      pullRequest: {
        url: "https://gitlab.com/group/repo/-/merge_requests/1906",
        title: "Old MR",
        state: "closed",
        baseRefName: "main",
        headRefName: "dev/sciforum-frontend-v2",
        isMerged: false,
      },
    });

    expect(projectPullRequestForCheckoutDisplay(snapshot)).toBeNull();
  });
});
