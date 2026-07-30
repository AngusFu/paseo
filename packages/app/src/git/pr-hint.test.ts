import { describe, expect, it } from "vitest";

import { selectPrHintFromStatus } from "./pr-hint";

const githubStatus = {
  url: "https://github.com/acme/repo/pull/42",
  state: "open",
  isMerged: false,
};

const gitlabStatus = {
  url: "https://gitlab.com/group/proj/-/merge_requests/7",
  state: "open",
  isMerged: false,
};

const closedGitlabStatus = {
  ...gitlabStatus,
  state: "closed",
};

describe("selectPrHintFromStatus", () => {
  it("defaults the forge to github when none is supplied (old daemon)", () => {
    const hint = selectPrHintFromStatus(githubStatus);
    expect(hint).toMatchObject({ number: 42, forge: "github" });
  });

  it("carries the resolved forge onto the hint", () => {
    const hint = selectPrHintFromStatus(githubStatus, "github");
    expect(hint?.forge).toBe("github");
  });

  it("parses a GitLab merge-request URL and carries the gitlab forge", () => {
    const hint = selectPrHintFromStatus(gitlabStatus, "gitlab");
    expect(hint).toMatchObject({ number: 7, forge: "gitlab" });
  });

  it("passes an unknown forge id through untouched", () => {
    const hint = selectPrHintFromStatus(githubStatus, "bitbucket");
    expect(hint?.forge).toBe("bitbucket");
  });

  it("returns null when a closed MR is on the repository default branch", () => {
    expect(
      selectPrHintFromStatus(closedGitlabStatus, "gitlab", {
        currentBranch: "dev/sciforum-frontend-v2",
        defaultBranch: "dev/sciforum-frontend-v2",
      }),
    ).toBeNull();
  });

  it("keeps a closed MR visible on a feature branch checkout", () => {
    expect(
      selectPrHintFromStatus(closedGitlabStatus, "gitlab", {
        currentBranch: "feature/auth",
        defaultBranch: "main",
      }),
    ).toMatchObject({ number: 7, state: "closed" });
  });

  it("returns null when the url has no parseable change-request number", () => {
    expect(
      selectPrHintFromStatus({ url: "https://example.com/x", state: "open", isMerged: false }),
    ).toBeNull();
  });
});
